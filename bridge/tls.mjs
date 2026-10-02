// bridge/tls.mjs — pinned HTTPS for the watch bridge.
//
// Trust model: the bridge serves HTTPS with a private, locally generated
// certificate (see setup-cert.sh; the private key is never committed). The
// watch pins the certificate's SHA-256 (DER) fingerprint, entered at pairing
// time, and verifies it BEFORE sending any token, audio or data. The
// fingerprint is the stable bridge identity: it survives DHCP/IP changes,
// while a bare IP address does not.
//
// Importing this module performs no I/O.

import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'

/** SHA-256 over the DER bytes of a PEM certificate → base64 fingerprint. */
export function certSha256Pin (certPem) {
  const b64 = String(certPem)
    .split('\n')
    .filter(line => !line.includes('-----BEGIN') && !line.includes('-----END'))
    .join('')
    .trim()
  const der = Buffer.from(b64, 'base64')
  if (!der.length) throw new Error('empty certificate')
  return createHash('sha256').update(der).digest('base64')
}

/** Constant-time fingerprint comparison (both base64 SHA-256). */
export function pinOk (presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false
  if (!presented || !expected) return false
  const a = Buffer.from(presented, 'base64')
  const b = Buffer.from(expected, 'base64')
  if (a.length !== b.length || a.length !== 32) return false
  return timingSafeEqual(a, b)
}

/** Read cert/key pair; throws with an actionable message when absent. */
export function loadTlsCredentials ({ certFile, keyFile, fs = null } = {}) {
  const read = fs?.readFileSync ?? readFileSync
  if (!certFile || !keyFile) throw new Error('TLS cert/key paths are required')
  try {
    const cert = read(certFile, 'utf8')
    const key = read(keyFile, 'utf8')
    if (!cert.trim() || !key.trim()) throw new Error('empty')
    return { cert, key, fingerprint: certSha256Pin(cert) }
  } catch (e) {
    throw new Error(
      `missing TLS credentials (${certFile}): generate a private local certificate ` +
      `with bridge/setup-cert.sh (BRIDGE_ALLOW_INSECURE_HTTP=1 opts into cleartext LAN legacy mode)`,
    )
  }
}

/**
 * Create the bridge server. HTTPS when credentials are provided; cleartext
 * HTTP only with explicit allowInsecureHttp (visible legacy opt-in, never a
 * silent downgrade). The bridge never issues redirects, so there is nothing
 * for a client to follow — and no token can leak into a redirect target.
 */
export function createBridgeServer ({ handler, tls = null, allowInsecureHttp = false } = {}) {
  if (typeof handler !== 'function') throw new Error('handler is required')
  if (tls && tls.cert && tls.key) return https.createServer({ cert: tls.cert, key: tls.key }, handler)
  if (allowInsecureHttp) return http.createServer(handler)
  throw new Error(
    'refusing to serve cleartext without BRIDGE_ALLOW_INSECURE_HTTP=1: ' +
    'generate a certificate with bridge/setup-cert.sh',
  )
}
