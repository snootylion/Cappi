import { describe, expect, it } from 'vitest'
import {
  checkWatchSessionScope,
  NOT_WATCH_SESSION,
  WATCH_SESSION_UNCONFIGURED,
} from '../src/session-scope.ts'

describe('watch-linked session scope', () => {
  it('acts only in the configured watch session', () => {
    expect(checkWatchSessionScope('watch-1', 'watch-1')).toEqual({ ok: true })
  })

  it('refuses any other calling session without touching the bridge', () => {
    expect(checkWatchSessionScope('other-session', 'watch-1')).toEqual({
      ok: false,
      error: NOT_WATCH_SESSION,
    })
    expect(checkWatchSessionScope(undefined, 'watch-1')).toEqual({
      ok: false,
      error: NOT_WATCH_SESSION,
    })
    expect(NOT_WATCH_SESSION).toBe('not the watch session')
  })

  it('fails closed while the watch session is unconfigured', () => {
    for (const missing of [undefined, '', '   ']) {
      expect(checkWatchSessionScope('watch-1', missing)).toEqual({
        ok: false,
        error: WATCH_SESSION_UNCONFIGURED,
      })
    }
  })
})
