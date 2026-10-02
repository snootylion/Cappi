import { describe, expect, it } from 'vitest'
import {
  fetchCapabilities,
  resolveActionCapability,
  type BridgeCapabilities,
} from '../src/capabilities.ts'
import type { BridgeFetch } from '../src/bridge-client.ts'
import { resolveWatchConfig } from '../src/config.ts'

// Explicit-pack example snapshots (stub transport; NOT the registry default,
// which is cappi-original). Each test below drives one explicitly selected
// pack's vocabulary so pack coverage never depends on the default.
const DOT: BridgeCapabilities = {
  characterId: 'dot-default',
  characters: ['dot-default', 'ember-min'],
  modelSelectable: ['idle_a', 'idle_b', 'idle_c', 'listen', 'talk_a', 'talk_b', 'work_set', 'celebrate'],
  roles: {
    idle: ['idle_a', 'idle_b', 'idle_c'],
    talk: ['talk_a', 'talk_b'],
    work: ['work_set'],
    celebrate: ['celebrate'],
  },
}

const EMBER: BridgeCapabilities = {
  characterId: 'ember-min',
  characters: ['dot-default', 'ember-min'],
  modelSelectable: ['idle_a', 'idle_b', 'idle_c', 'listen', 'talk', 'work_set'],
  roles: {
    idle: ['idle_a', 'idle_b', 'idle_c'],
    talk: ['talk'],
    work: ['work_set'],
  },
}

function capsFetch(payload: unknown, status = 200): BridgeFetch {
  return (async (url: string) => {
    if (!url.endsWith('/watch/capabilities')) throw new Error(`unexpected path ${url}`)
    return { ok: status >= 200 && status < 300, status, json: async () => payload }
  }) as BridgeFetch
}

describe('capabilities query (read-only GET)', () => {
  it('parses the authenticated capability snapshot', async () => {
    // Explicit loopback http for stub-transport tests (secure default is
    // https+pin; stubs pin an explicit local target, never ambient env).
    const config = resolveWatchConfig({ bridgeBaseUrl: 'http://127.0.0.1:8787', bridgeToken: 't', watchSessionId: 'watch-1' })
    const result = await fetchCapabilities(config, capsFetch({
      ok: true, version: '0.2.0', characterId: 'dot-default',
      characters: ['dot-default', 'ember-min'], modelSelectable: DOT.modelSelectable, roles: DOT.roles,
    }))
    expect(result).toEqual({ ok: true, capabilities: expect.objectContaining({ characterId: 'dot-default' }) })
    if (result.ok) expect(result.capabilities.modelSelectable).toContain('celebrate')
  })

  it('fails closed on unusable shapes, rejections, and missing tokens', async () => {
    const config = resolveWatchConfig({ bridgeBaseUrl: 'http://127.0.0.1:8787', bridgeToken: 't', watchSessionId: 'watch-1' })
    expect((await fetchCapabilities(config, capsFetch({ ok: true }))).ok).toBe(false)
    expect((await fetchCapabilities(config, capsFetch({ ok: false, error: 'bad token' }, 401))).ok).toBe(false)
    const noToken = resolveWatchConfig({ bridgeBaseUrl: 'http://127.0.0.1:8787', watchSessionId: 'watch-1', bridgeTokenPath: '/nonexistent/token' })
    const missing = await fetchCapabilities(noToken, capsFetch({}))
    expect(missing).toEqual({ ok: false, error: 'bridge token is not configured' })
  })
})

describe('capability resolution (fail-fast mirror; bridge re-resolves)', () => {
  it('passes direct hits and clear', () => {
    expect(resolveActionCapability('talk_a', DOT)).toEqual({ ok: true, action: 'talk_a' })
    expect(resolveActionCapability(null, DOT)).toEqual({ ok: true, action: null })
  })

  it('maps legacy ids through the pack role table (explicit dot-default selection)', () => {
    expect(resolveActionCapability('dance', DOT)).toEqual({ ok: true, action: 'celebrate' })
    expect(resolveActionCapability('shadow', DOT)).toEqual({ ok: true, action: 'celebrate' })
    expect(resolveActionCapability('work', DOT)).toEqual({ ok: true, action: 'work_set' })
    expect(resolveActionCapability('talk2', DOT)).toEqual({ ok: true, action: 'talk_a' })
    expect(resolveActionCapability('breath', DOT)).toEqual({ ok: true, action: 'listen' })
  })

  it('refuses legacy ids with no pack coverage, naming the callable list (explicit ember-min selection)', () => {
    expect(resolveActionCapability('dance', EMBER)).toEqual({
      ok: false,
      error: expect.stringContaining('callable: idle_a, idle_b, idle_c, listen, talk, work_set'),
    })
    expect(resolveActionCapability('shadow', EMBER)).toEqual({
      ok: false,
      error: expect.stringContaining('callable: idle_a, idle_b, idle_c, listen, talk, work_set'),
    })
  })

  it('never resolves state-owned cues or unknown ids', () => {
    for (const id of ['question', 'static_hold']) {
      expect(resolveActionCapability(id, DOT)).toEqual({
        ok: false,
        error: `action '${id}' is state-owned and not model-requestable`,
      })
    }
    const unknown = resolveActionCapability('fly', DOT)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.error).toContain('unknown action: fly')
      expect(unknown.error).toContain('dot-default')
    }
  })
})
