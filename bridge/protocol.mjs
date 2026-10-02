// bridge/protocol.mjs — watch↔bridge protocol version and feature advertisement.
//
// Pure constants + tiny helpers: importing this module performs no I/O,
// opens no sockets and reads no credentials. The version is exposed on the
// SSE hello, GET /watch/state and GET /watch/capabilities so watch, plugin
// and bridge can fail with a compatibility error instead of misbehaving.
//
// Version history:
//   0.1.0 — pre-character baseline (hello version, /watch/cappi legacy ids).
//   0.2.0 — character selection + capabilities + session-bound character
//           effects + legacy cappi alias (this module).

export const PROTOCOL_VERSION = '0.2.0'
export const MIN_COMPATIBLE_PROTOCOL = '0.1.0'

/** Feature flags advertised beside the version (all supported since 0.2.0). */
export const PROTOCOL_FEATURES = Object.freeze([
  'character-select',   // POST /watch/command {cmd:'character-select', characterId}
  'character-sse',      // SSE t:'character' {characterId} on selection
  'capabilities',       // GET /watch/capabilities (authenticated)
  'session-binding',    // /watch/cappi requires body.sessionId == watched session
  'legacy-cappi-alias', // /watch/cappi maps legacy action ids to pack capabilities
])

/** Route table fragment owned by the character contract (see WATCH_ROUTES). */
export const CHARACTER_ROUTES = Object.freeze([
  'GET /watch/capabilities',
])

export function protocolHello () {
  return { version: PROTOCOL_VERSION, features: [...PROTOCOL_FEATURES] }
}

/**
 * Compatibility check for a peer-reported version string. Returns null when
 * compatible, else a human-readable incompatibility reason (callers surface
 * it as the error instead of proceeding).
 */
export function checkProtocolCompat (peerVersion) {
  if (typeof peerVersion !== 'string' || !peerVersion) return 'missing protocol version'
  const parse = (v) => String(v).split('.').map((n) => Number(n))
  const [aMaj = NaN, aMin = 0] = parse(peerVersion)
  const [bMaj = NaN, bMin = 0] = parse(MIN_COMPATIBLE_PROTOCOL)
  if (!Number.isSafeInteger(aMaj) || !Number.isSafeInteger(aMin)) return `unparseable protocol version: ${peerVersion}`
  if (aMaj !== bMaj || aMin < bMin) {
    return `incompatible protocol ${peerVersion} (bridge ${PROTOCOL_VERSION}; minimum ${MIN_COMPATIBLE_PROTOCOL})`
  }
  return null
}
