// bridge/session-binding.mjs — atomic watched-session guard for character effects.
//
// The bridge follows exactly one harness session (dsh.mjs activeSessionId:
// manual pin or auto-follow). Model-initiated character effects
// (/watch/cappi) must apply to the session the model call ran in — never to
// whatever session the bridge happened to follow by the time an awaited RPC
// resolves. This module is the guard; callers keep it atomic by capturing the
// watched id and applying the effect synchronously with NO await between the
// check and the effect (one Node event-loop turn; no interleaving possible).
//
// Pure: no I/O, no sockets, no credentials.

/**
 * Check a claimed caller session against the currently watched session.
 * Returns { ok:true } or { ok:false, status, error }. Both ids are opaque
 * strings; comparison is exact (case-sensitive, no trimming surprises — the
 * plugin sends exec.agent.id verbatim and the bridge compares verbatim).
 */
export function checkSessionBinding ({ claimed, watched }) {
  if (typeof claimed !== 'string' || !claimed) {
    return { ok: false, status: 400, error: 'session binding required: send the calling session id as sessionId' }
  }
  if (typeof watched !== 'string' || !watched) {
    return { ok: false, status: 409, error: 'no watched session; select a session before character actions' }
  }
  if (claimed !== watched) {
    return { ok: false, status: 409, error: 'not the watched session: the bridge followed a different session' }
  }
  return { ok: true }
}
