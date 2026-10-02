// bridge/discovery.mjs — bounded LAN discovery responder.
//
// Security posture: UDP discovery is UNTRUSTED. A probe reply proves
// nothing — any LAN host (or relay) can answer. Replies are a candidate
// list only; the watch must verify the bridge's pinned certificate
// fingerprint over HTTPS before transmitting its token. The legacy
// /watch/pair-probe nonce-echo is a liveness check only: it confers no
// trust, proves no identity, and must never be described as
// authentication under any name.
//
// Bounds: packets over MAX_DISCOVERY_BYTES are dropped, nonces must match
// NONCE_RE, ports are validated to 1..65535, and replies carry no secret.
//
// Importing this module performs no I/O.

import dgram from 'node:dgram'

export const PROBE_PREFIX = 'DSHW1DISCOVER '
export const REPLY_PREFIX = 'DSHW1BRIDGE '
export const NONCE_RE = /^[\w-]{1,64}$/

/**
 * Pure packet handler. Returns the reply string for a valid probe, or null
 * to stay silent (wrong prefix, oversize, malformed nonce). Exported for
 * offline tests; the socket path below is the only I/O entry point.
 */
export function handleDiscoveryPacket (text, servicePort) {
  if (typeof text !== 'string') return null
  if (Buffer.byteLength(text, 'utf8') > 512) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith(PROBE_PREFIX)) return null
  const nonce = trimmed.slice(PROBE_PREFIX.length).trim()
  if (!NONCE_RE.test(nonce)) return null
  if (!Number.isSafeInteger(servicePort) || servicePort < 1 || servicePort > 65535) return null
  return `${REPLY_PREFIX}${nonce} ${servicePort}`
}

/** Parse a discovery reply. Returns {nonce, port} or null (foreign/garbled). */
export function parseDiscoveryReply (text, nonce) {
  if (typeof text !== 'string' || typeof nonce !== 'string') return null
  if (Buffer.byteLength(text, 'utf8') > 512) return null
  const prefix = `${REPLY_PREFIX}${nonce} `
  const trimmed = text.trim()
  if (!trimmed.startsWith(prefix)) return null
  const port = Number(trimmed.slice(prefix.length).trim())
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null
  return { nonce, port }
}

export const DEFAULT_DISCOVERY_PORTS = Object.freeze(Array.from({ length: 10 }, (_, i) => 8788 + i))

/** First available known port; explicit custom port is never silently replaced.
 * Port 0 is test-only. Caller owns close(); discoveryStatus is safe for health.
 */
export function startDiscovery ({ port, ports, servicePort, log = () => {}, host = '0.0.0.0' } = {}) {
  const candidates = ports ?? (port === undefined ? DEFAULT_DISCOVERY_PORTS : [port])
  if (!candidates.length || candidates.some(p => !Number.isSafeInteger(p) || p < 0 || p > 65535)) {
    throw new Error(`invalid discovery port: ${port}`)
  }
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: false })
  let index = 0
  udp.discoveryStatus = { state: 'starting', port: null }
  udp.on('error', e => {
    if (e.code === 'EADDRINUSE' && ++index < candidates.length) {
      udp.bind(candidates[index], host)
      return
    }
    udp.discoveryStatus = { state: 'failed', port: null, error: 'discovery-bind-failed',
      action: 'Free a UDP port in 8788..8797 or configure BRIDGE_DISCOVERY_PORT and probe it under Advanced.' }
    log(udp.discoveryStatus.action)
    try { udp.close() } catch {}
  })
  udp.on('message', (msg, rinfo) => {
    if (msg.length > 512) return
    const reply = handleDiscoveryPacket(msg.toString('utf8'), servicePort)
    if (reply) udp.send(reply, rinfo.port, rinfo.address, () => {})
  })
  udp.on('listening', () => {
    const bound = udp.address().port
    udp.discoveryStatus = { state: 'ready', port: bound }
    log(`udp :${bound} answering probes`)
  })
  udp.bind(candidates[0], host)
  return udp
}
