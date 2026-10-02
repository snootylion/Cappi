/**
 * Portable plugin configuration.
 *
 * Every value is configurable through plugin config with an environment
 * override; defaults are loopback-safe and contain no personal addresses,
 * profile paths, or credentials:
 *
 * - `bridgeBaseUrl` (env `DSH_WATCH_BRIDGE_URL`, default
 *   `https://127.0.0.1:8787`) — the bridge to POST `/watch/cappi` to. The
 *   default matches the bridge secure default (HTTPS only): `https:` targets
 *   require the pinned certificate (see `bridgeCertPin`) and fail closed
 *   with no token sent until the pin is configured. Explicit loopback `http:`
 *   stays allowed for local review fixtures; non-loopback `http:` needs the
 *   explicit LAN opt-in.
 * - `bridgeToken` (env `DSH_WATCH_BRIDGE_TOKEN`) — token value; preferred in
 *   test/CI fixtures. When absent, `bridgeTokenPath` is read instead.
 * - `bridgeTokenPath` (env `DSH_WATCH_BRIDGE_TOKEN_PATH`, default
 *   `<DSH_HOME>/dsh-watch/bridge/token`) — mode-600 token file.
 * - `bridgeCertPin` (env `DSH_WATCH_BRIDGE_PIN`, default empty) — pinned
 *   bridge certificate SHA-256 (base64 of the DER bytes, with or without the
 *   `sha256/` prefix; same convention as the watch SecureTransport pin).
 *   Required for `https:` targets (fail-closed); unused for loopback `http:`.
 * - `watchSessionId` (env `DSH_WATCH_SESSION_ID`, default empty) — the
 *   watch-linked harness session. Empty fails closed (see session-scope.ts).
 * - `manifestPath` (env `DSH_WATCH_MANIFEST_PATH`, default empty) — optional
 *   character manifest for capability-driven actions. Empty means the bridge
 *   allowlist alone applies.
 * - `allowInsecureLan` (env `DSH_WATCH_ALLOW_INSECURE_LAN`, default false) —
 *   explicit opt-in for cleartext non-loopback bridge URLs. Without it,
 *   non-loopback targets must be `https:` (bridge C pinned-HTTPS contract).
 * - `timeoutMs` (env `DSH_WATCH_TIMEOUT_MS`, default 8000) — bridge POST
 *   budget, 1000–30000 ms.
 */

import { homedir } from 'node:os'
import path from 'node:path'

export const DEFAULT_BRIDGE_BASE_URL = 'https://127.0.0.1:8787'
export const DEFAULT_BRIDGE_TIMEOUT_MS = 8_000

export interface WatchPluginConfig {
  bridgeBaseUrl?: string
  bridgeToken?: string
  bridgeTokenPath?: string
  bridgeCertPin?: string
  watchSessionId?: string
  manifestPath?: string
  allowInsecureLan?: boolean
  timeoutMs?: number
}

export interface ResolvedWatchConfig {
  readonly bridgeBaseUrl: string
  readonly bridgeToken: string | undefined
  readonly bridgeTokenPath: string
  readonly bridgeCertPin: string
  readonly watchSessionId: string
  readonly manifestPath: string | undefined
  readonly allowInsecureLan: boolean
  readonly timeoutMs: number
}

export function defaultBridgeTokenPath(dshHome: string = defaultDshHome()): string {
  return path.join(dshHome, 'dsh-watch', 'bridge', 'token')
}

export function defaultDshHome(): string {
  return process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh')
}

/** Resolve effective config: explicit values win, then env, then defaults. */
export function resolveWatchConfig(raw: WatchPluginConfig = {}): ResolvedWatchConfig {
  const bridgeBaseUrl = firstNonBlank(
    raw.bridgeBaseUrl,
    process.env.DSH_WATCH_BRIDGE_URL,
    DEFAULT_BRIDGE_BASE_URL,
  )!
  const bridgeToken = firstNonBlank(raw.bridgeToken, process.env.DSH_WATCH_BRIDGE_TOKEN)
  const bridgeTokenPath = firstNonBlank(
    raw.bridgeTokenPath,
    process.env.DSH_WATCH_BRIDGE_TOKEN_PATH,
    defaultBridgeTokenPath(),
  )!
  const bridgeCertPin = normalizeBridgePin(
    firstNonBlank(raw.bridgeCertPin, process.env.DSH_WATCH_BRIDGE_PIN) ?? '',
  )
  const watchSessionId = firstNonBlank(raw.watchSessionId, process.env.DSH_WATCH_SESSION_ID) ?? ''
  const manifestPath = firstNonBlank(raw.manifestPath, process.env.DSH_WATCH_MANIFEST_PATH)
  const allowInsecureLan = firstBoolean(raw.allowInsecureLan, process.env.DSH_WATCH_ALLOW_INSECURE_LAN) ?? false
  const timeoutMs = clampInt(
    firstNumber(raw.timeoutMs, envNumber(process.env.DSH_WATCH_TIMEOUT_MS)),
    1_000,
    30_000,
    DEFAULT_BRIDGE_TIMEOUT_MS,
  )
  return { bridgeBaseUrl, bridgeToken, bridgeTokenPath, bridgeCertPin, watchSessionId, manifestPath, allowInsecureLan, timeoutMs }
}

/**
 * Decide whether a bridge base URL may be used. The secure default is
 * loopback `https:` with the pinned certificate (matching the bridge HTTPS
 * default); `https:` targets additionally require a pinned certificate
 * (`certPin`, same DER-SHA256 convention as the watch) without exception —
 * loopback included — so there is no fallback to system PKI, no silent
 * downgrade to http, and no token sent until the pin verifies. Explicit
 * loopback `http:` stays allowed for local review fixtures; non-loopback
 * `http:` requires the explicit `allowInsecureLan` opt-in.
 */
export function checkBridgeUrl(
  baseUrl: string,
  allowInsecureLan: boolean,
  certPin = '',
): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return { ok: false, error: `invalid bridge URL: ${baseUrl}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `unsupported bridge URL scheme: ${url.protocol}` }
  }
  if (url.username || url.password) {
    return { ok: false, error: 'bridge URL must not embed credentials' }
  }
  if (/[?&]token=/i.test(url.search)) {
    return { ok: false, error: 'bridge URL must not embed a token; the token travels in the X-Bridge-Token header only' }
  }
  if (url.protocol === 'https:') {
    if (!normalizeBridgePin(certPin)) {
      return { ok: false, error: 'bridge pin is not configured: https targets require the pinned certificate SHA-256 (DSH_WATCH_BRIDGE_PIN)' }
    }
    return { ok: true, url }
  }
  if (isLoopbackHost(url.hostname)) return { ok: true, url }
  if (allowInsecureLan) return { ok: true, url }
  return {
    ok: false,
    error: 'non-loopback bridge URL must use https (or set allowInsecureLan for explicit cleartext LAN opt-in)',
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/**
 * Normalize a user-entered bridge certificate pin to canonical storage form:
 * base64 of exactly 32 bytes (SHA-256 over the certificate DER bytes), same
 * convention as the watch `SecureTransport.normalizePin`. Accepts the
 * `sha256/<base64>` display form as well as bare base64; blank input returns
 * blank (meaning "no pin configured"); malformed input returns blank so the
 * https gate fails closed with the not-configured error. Never throws.
 */
export function normalizeBridgePin(input: string): string {
  try {
    let b64 = String(input ?? '').trim()
    if (!b64) return ''
    if (/^sha256\//i.test(b64)) b64 = b64.slice(7).trim()
    if (!b64) return ''
    const bytes = Buffer.from(b64, 'base64')
    if (bytes.length !== 32) return ''
    return bytes.toString('base64')
  } catch {
    return ''
  }
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function firstBoolean(...values: Array<boolean | string | undefined>): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value
    if (typeof value === 'string' && value.trim()) {
      const normalized = value.trim().toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
      if (['0', 'false', 'no', 'off'].includes(normalized)) return false
    }
  }
  return undefined
}

function envNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function clampInt(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}
