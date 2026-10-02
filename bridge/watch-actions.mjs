// bridge/watch-actions.mjs — character domain router (extracted from bridge.mjs).
//
// Session-bound character effects with injected dependencies so offline tests
// drive the exact production logic without a live harness, sockets or
// credentials. Importing this module performs no I/O.
//
// Atomicity contract (TOCTOU guard): handleCappiBody captures the watched
// session id ONCE via getWatchedSession, then runs the binding check, the
// capability resolution and the effect (setCappiAction + notify)
// synchronously with no await between them. One event-loop turn admits no
// interleaving session switch, so the effect provably lands on the session
// the caller was bound to.

import { resolveCappiAction } from './characters.mjs'
import { checkSessionBinding } from './session-binding.mjs'
import { protocolHello } from './protocol.mjs'

export function createWatchActions (deps) {
  const { getWatchedSession, chars, registry, getCappiAction, setCappiAction, notify } = deps
  if (typeof getWatchedSession !== 'function') throw new Error('getWatchedSession is required')
  if (!chars) throw new Error('character store is required')
  if (!registry) throw new Error('character registry is required')

  return {
    /** Authenticated capability snapshot for plugins (read-only, no effects). */
    describeCapabilities () {
      const described = chars.describe()
      const packRoles = registry?.characters?.[chars.selected]?.roles ?? {}
      return {
        ok: true,
        ...protocolHello(),
        characterId: chars.selected,
        characters: described.characters,
        modelSelectable: [...described.modelSelectable],
        roles: { ...packRoles },
        cappiAction: typeof getCappiAction === 'function' ? getCappiAction() : null,
      }
    },

    /**
     * POST /watch/cappi body handler. Returns { status, payload }.
     * Body: { action, sessionId }. sessionId is the caller's harness session
     * id (the plugin sends exec.agent.id verbatim); it must equal the
     * currently watched session, checked atomically before any effect.
     */
    handleCappiBody (body) {
      if (body == null || typeof body !== 'object' || Array.isArray(body)) {
        return { status: 400, payload: { ok: false, error: 'bad body' } }
      }
      if (!Object.hasOwn(body, 'action')) {
        return { status: 400, payload: { ok: false, error: 'missing action' } }
      }
      // Capture once: everything below is synchronous, so this snapshot is
      // the session the effect lands on (TOCTOU guard).
      const watched = getWatchedSession()
      const bound = checkSessionBinding({ claimed: body.sessionId, watched })
      if (!bound.ok) return { status: bound.status, payload: { ok: false, error: bound.error } }
      const resolved = resolveCappiAction(registry, chars.selected, body.action)
      if (!resolved.ok) return { status: 400, payload: { ok: false, error: resolved.error } }
      setCappiAction(resolved.action)
      notify({ t: 'cappi', action: resolved.action })
      return { status: 200, payload: { ok: true, action: resolved.action, characterId: resolved.characterId } }
    },

    /**
     * POST /watch/command {cmd:'character-select'} handler. The watch's local
     * choice (token-authenticated; the watch holds no harness session id, so
     * no session binding applies here — binding guards MODEL effects, not the
     * watch's own pack choice). Persists via the store's persist callback.
     */
    handleCharacterSelect (body) {
      const requested = typeof body?.characterId === 'string' ? body.characterId : ''
      const out = chars.select(requested)
      if (!out.ok) return { status: 400, payload: { ok: false, error: out.error } }
      // A pack switch retires any held model action: the old pack's action
      // ids are meaningless on the new pack and must not linger.
      setCappiAction(null)
      notify({ t: 'character', characterId: out.characterId })
      return { status: 200, payload: { ok: true, characterId: out.characterId } }
    },
  }
}
