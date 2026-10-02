/**
 * Pinned bridge transport for the watch plugin (no dependencies).
 *
 * Contract (mirrors the watch `SecureTransport` + bridge C rules):
 *
 * - `https:` targets verify the bridge certificate's SHA-256 pin (base64 of
 *   the DER bytes, `sha256/` prefix accepted) during the TLS handshake,
 *   BEFORE any token or body is sent. There is no fallback to system PKI
 *   and no silent downgrade to `http:` — a mismatch fails closed.
 * - `http:` is allowed only for loopback (the local default) or with the
 *   explicit `allowInsecureLan` opt-in for non-loopback (checked upstream).
 * - The client never follows redirects: any 3xx is surfaced as an error
 *   (the bridge never redirects, so a 3xx proves a middlebox or impostor).
 * - The token never appears in a URL: token-bearing URLs are refused before
 *   any byte is sent, and requests are confined to the configured bridge
 *   origin under `/watch/`.
 * - Only read-only discovery state (bounds/timeouts) travels here; nothing
 *   in this module authenticates — the pin + header token do.
 */

import http from 'node:http'
import https from 'node:https'
import { createHash, timingSafeEqual } from 'node:crypto'
import { checkBridgeUrl, type ResolvedWatchConfig } from './config.ts'

export const BRIDGE_TOKEN_HEADER = 'x-bridge-token'

export interface BridgeResponse {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

export interface BridgeFetch {
  (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<BridgeResponse>
}

const MAX_BODY_BYTES = 1 << 20

/** Constant-time base64 pin comparison (both must decode to 32 bytes). */
export function bridgePinMatches(presentedB64: string, expectedB64: string): boolean {
  try {
    const a = Buffer.from(String(presentedB64), 'base64')
    const b = Buffer.from(String(expectedB64), 'base64')
    if (a.length !== 32 || b.length !== 32) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** SHA-256 pin (base64) of DER certificate bytes — same convention as the watch. */
export function certDerSha256Pin(der: Buffer): string {
  return createHash('sha256').update(der).digest('base64')
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Build the default bridge fetch for one resolved config. The returned
 * function satisfies `BridgeFetch` so tests can keep injecting stubs.
 */
export function createBridgeFetch(config: ResolvedWatchConfig): BridgeFetch {
  return (url, init) => pinnedRequest(config, url, init)
}

async function pinnedRequest(
  config: ResolvedWatchConfig,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
): Promise<BridgeResponse> {
  const checked = checkBridgeUrl(config.bridgeBaseUrl, config.allowInsecureLan, config.bridgeCertPin)
  if (!checked.ok) throw new Error(checked.error)
  let target: URL
  try {
    target = new URL(url)
  } catch {
    throw new Error(`invalid bridge request URL: ${url}`)
  }
  if (/[?&]token=/i.test(target.search)) {
    throw new Error('refusing to send a token-bearing URL')
  }
  if (target.origin !== checked.url.origin) {
    throw new Error('refusing to leave the configured bridge origin')
  }
  if (!target.pathname.startsWith('/watch/')) {
    throw new Error('refusing a non-/watch bridge path')
  }
  if (init.signal.aborted) throw abortError()

  return new Promise<BridgeResponse>((resolve, reject) => {
    const secure = target.protocol === 'https:'
    const lib = secure ? https : http
    const expectedPin = config.bridgeCertPin
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      init.signal.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      reject(error)
    }
    // NOTE: the pin is verified in `verifyPeerPin` below — NOT via
    // `checkServerIdentity`, which this runtime never invokes when
    // `rejectUnauthorized: false` (measured on Node 26: the callback stays
    // silent and the handshake would complete unverified). The request body
    // (and therefore the token header flush) is gated on verification: for
    // https nothing is written until `secureConnect` has delivered a
    // matching pin, so a mismatch sends zero bytes.
    const req = lib.request(
      target,
      {
        method: init.method,
        headers: init.headers,
        // The pin IS the trust root (private local CA): system PKI is off
        // and hostname checks are subsumed by pinning, exactly like the
        // watch SecureTransport.
        ...(secure ? { rejectUnauthorized: false, agent: false } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) {
          res.resume()
          reject(new Error(`bridge redirected (HTTP ${status}); refusing to follow`))
          return
        }
        let size = 0
        const parts: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            res.destroy()
            reject(new Error('bridge response too large'))
            return
          }
          parts.push(chunk)
        })
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8')
          init.signal.removeEventListener('abort', onAbort)
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => {
              try {
                return text ? (JSON.parse(text) as unknown) : undefined
              } catch {
                return undefined
              }
            },
          })
        })
        res.on('error', reject)
      },
    )
    req.on('error', (cause: unknown) => {
      if (settled) return
      if (init.signal.aborted) fail(abortError())
      else fail(cause instanceof Error ? cause : new Error('bridge request failed'))
    })
    const onAbort = (): void => {
      req.destroy(abortError())
    }
    init.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      req.destroy(abortError())
    }, Math.max(1_000, Math.min(30_000, config.timeoutMs)))
    req.on('socket', (socket: {
      once(event: string, listener: () => void): void
      getPeerCertificate(detailed: boolean): { raw?: Buffer }
    }) => {
      if (!secure) return
      const verify = (): void => {
        let raw: Buffer | undefined
        try {
          raw = socket.getPeerCertificate(true)?.raw
        } catch {
          raw = undefined
        }
        if (!raw || !raw.length || !bridgePinMatches(certDerSha256Pin(raw), expectedPin)) {
          req.destroy(new Error('bridge certificate pin mismatch (unpaired or rotated cert — re-enter the sha256/ pin)'))
          return
        }
        try {
          if (init.body) req.write(init.body)
          req.end()
        } catch (error) {
          fail(error instanceof Error ? error : new Error('bridge request failed'))
        }
      }
      // Fresh connection per request (agent: false), so secureConnect always
      // fires after assignment; fall back to an immediate check for safety.
      let already: { raw?: Buffer } | null = null
      try {
        already = socket.getPeerCertificate(true)
      } catch {
        already = null
      }
      if (already && already.raw?.length) verify()
      else socket.once('secureConnect', verify)
    })
    req.on('close', () => clearTimeout(timer))
    if (!secure) {
      try {
        if (init.body) req.write(init.body)
        req.end()
      } catch (error) {
        fail(error instanceof Error ? error : new Error('bridge request failed'))
      }
    }
  })
}
