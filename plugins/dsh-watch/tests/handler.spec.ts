import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { handleCappiAction } from '../src/handler.ts'
import { resolveWatchConfig } from '../src/config.ts'
import type { BridgeFetch } from '../src/bridge-client.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const src = (name: string) => readFileSync(path.join(ROOT, 'src', `${name}.ts`), 'utf8')

const DOT_CAPS = {
  // Explicit-pack example snapshot (stub transport): the explicitly selected
  // dot-default pack, NOT the registry default (cappi-original). Handler
  // tests drive this pack's vocabulary so behavior never depends on the
  // default; the default pack itself is covered by the real-registry E2E
  // (tests/e2e-secure-default.spec.ts) and the bridge suite.
  ok: true,
  version: '0.2.0',
  characterId: 'dot-default',
  characters: ['dot-default', 'ember-min'],
  modelSelectable: ['idle_a', 'idle_b', 'idle_c', 'listen', 'talk_a', 'talk_b', 'work_set', 'celebrate'],
  roles: {
    idle: ['idle_a', 'idle_b', 'idle_c'],
    listen: ['listen'],
    talk: ['talk_a', 'talk_b'],
    work: ['work_set'],
    celebrate: ['celebrate'],
    question: ['question'],
    neutral_hold: ['static_hold'],
  },
  cappiAction: null,
}

interface SeenCall {
  readonly url: string
  readonly body: string
}

/** Stub transport routing the read-only capabilities GET and the cappi POST. */
function routedFetch(seen: SeenCall[], cappiImpl?: (body: Record<string, unknown>) => unknown): BridgeFetch {
  return (async (url: string, init: { body: string }) => {
    seen.push({ url, body: String(init.body) })
    if (url.endsWith('/watch/capabilities')) {
      return { ok: true, status: 200, json: async () => DOT_CAPS }
    }
    if (url.endsWith('/watch/cappi')) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      if (cappiImpl) return cappiImpl(body)
      return { ok: true, status: 200, json: async () => ({ ok: true, action: body.action ?? null }) }
    }
    throw new Error(`unexpected bridge path ${url}`)
  }) as BridgeFetch
}

describe('cappi tool handler', () => {
  it('refuses the wrong session before validating or calling the bridge', async () => {
    const config = resolveWatchConfig({ bridgeBaseUrl: 'http://127.0.0.1:8787', bridgeToken: 't', watchSessionId: 'watch-1' })
    const result = await handleCappiAction('intruder', { action: 'not-an-action' }, config, {
      fetchImpl: (async () => {
        throw new Error('bridge must not be called for the wrong session')
      }) as BridgeFetch,
    })
    expect(result).toEqual({ ok: false, error: 'not the watch session' })
  })

  it('refuses malformed input without any bridge call', async () => {
    const config = resolveWatchConfig({ bridgeBaseUrl: 'http://127.0.0.1:8787', bridgeToken: 't', watchSessionId: 'watch-1' })
    const result = await handleCappiAction('watch-1', { action: '' }, config, {
      fetchImpl: (async () => {
        throw new Error('bridge must not be called for malformed input')
      }) as BridgeFetch,
    })
    expect(result).toEqual({ ok: false, error: 'bad action' })
  })

  it('enforces manifest capabilities before any bridge call', async () => {
    const config = resolveWatchConfig({
      bridgeBaseUrl: 'http://127.0.0.1:8787',
      bridgeToken: 't',
      watchSessionId: 'watch-1',
      manifestPath: 'manifest.json',
    })
    const result = await handleCappiAction('watch-1', { action: 'shadow' }, config, {
      readManifestFile: async () => JSON.stringify({ actions: { dance: { model_selectable: true } } }),
      fetchImpl: (async () => {
        throw new Error('bridge must not be called without capability')
      }) as BridgeFetch,
    })
    expect(result).toEqual({
      ok: false,
      error: "action 'shadow' is not declared in the character manifest",
    })
  })

  it('fails closed on an unreadable manifest', async () => {
    const config = resolveWatchConfig({
      bridgeBaseUrl: 'http://127.0.0.1:8787',
      bridgeToken: 't',
      watchSessionId: 'watch-1',
      manifestPath: 'missing.json',
    })
    const seen: SeenCall[] = []
    const result = await handleCappiAction('watch-1', { action: 'dance' }, config, {
      readManifestFile: async () => {
        throw new Error('ENOENT')
      },
      fetchImpl: routedFetch(seen),
    })
    expect(result).toEqual({
      ok: false,
      error: 'character manifest is unreadable: missing.json',
    })
    expect(seen).toHaveLength(0)
  })

  it('queries capabilities but never POSTs for unknown actions', async () => {
    const config = resolveWatchConfig({ bridgeBaseUrl: 'http://127.0.0.1:8787', bridgeToken: 't', watchSessionId: 'watch-1' })
    const seen: SeenCall[] = []
    const result = await handleCappiAction('watch-1', { action: 'fly' }, config, {
      fetchImpl: routedFetch(seen),
    })
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('unknown action: fly'),
    })
    expect(seen.map((call) => call.url)).toEqual(['http://127.0.0.1:8787/watch/capabilities'])
  })

  it('refuses state-owned cues without a state-changing call', async () => {
    const config = resolveWatchConfig({ bridgeBaseUrl: 'http://127.0.0.1:8787', bridgeToken: 't', watchSessionId: 'watch-1' })
    const seen: SeenCall[] = []
    const result = await handleCappiAction('watch-1', { action: 'question' }, config, {
      fetchImpl: routedFetch(seen),
    })
    expect(result).toEqual({
      ok: false,
      error: "action 'question' is state-owned and not model-requestable",
    })
    expect(seen.map((call) => call.url)).toEqual(['http://127.0.0.1:8787/watch/capabilities'])
  })

  it('resolves legacy ids against capabilities and forwards the caller session verbatim', async () => {
    const config = resolveWatchConfig({ bridgeBaseUrl: 'http://127.0.0.1:8787', bridgeToken: 't', watchSessionId: 'watch-1' })
    const seen: SeenCall[] = []
    const result = await handleCappiAction('watch-1', { action: 'dance' }, config, {
      fetchImpl: routedFetch(seen),
    })
    expect(result).toEqual({ ok: true, action: 'celebrate' })
    const post = seen.find((call) => call.url.endsWith('/watch/cappi'))
    expect(post).toBeDefined()
    expect(JSON.parse(post!.body)).toEqual({ action: 'celebrate', sessionId: 'watch-1' })
  })

  it('forwards validated watch-session calls to the bridge', async () => {
    const config = resolveWatchConfig({ bridgeBaseUrl: 'http://127.0.0.1:8787', bridgeToken: 't', watchSessionId: 'watch-1' })
    const seen: SeenCall[] = []
    await expect(
      handleCappiAction('watch-1', { action: 'talk_a' }, config, { fetchImpl: routedFetch(seen) }),
    ).resolves.toEqual({ ok: true, action: 'talk_a' })
  })

  it('propagates bridge session-mismatch (409) as the tool result', async () => {
    const config = resolveWatchConfig({ bridgeBaseUrl: 'http://127.0.0.1:8787', bridgeToken: 't', watchSessionId: 'watch-1' })
    const seen: SeenCall[] = []
    const result = await handleCappiAction('watch-1', { action: 'talk_a' }, config, {
      fetchImpl: routedFetch(seen, () => ({
        ok: false,
        status: 409,
        json: async () => ({ ok: false, error: 'not the watched session: the bridge followed a different session' }),
      })),
    })
    expect(result).toEqual({
      ok: false,
      error: 'not the watched session: the bridge followed a different session',
    })
  })

  it('propagates capabilities failures without a POST', async () => {
    const config = resolveWatchConfig({ bridgeBaseUrl: 'http://127.0.0.1:8787', bridgeToken: 't', watchSessionId: 'watch-1' })
    const seen: SeenCall[] = []
    const result = await handleCappiAction('watch-1', { action: 'talk_a' }, config, {
      fetchImpl: (async (url: string) => {
        seen.push({ url, body: '' })
        if (url.endsWith('/watch/capabilities')) throw new Error('connection refused')
        throw new Error('must not POST without capabilities')
      }) as BridgeFetch,
    })
    expect(result).toEqual({ ok: false, error: 'bridge request failed: connection refused' })
    expect(seen.map((call) => call.url)).toEqual(['http://127.0.0.1:8787/watch/capabilities'])
  })
})

describe('no prompt/autosubmit regression', () => {
  const FORBIDDEN = [
    'SessionFace',
    '.prompt(',
    'createUserMessage',
    'ctx.llm',
    'run_code',
    'answerApproval',
  ]

  // NOTE (turnkey 0.3.0-rc0): `src/index.ts` is the composition root and now
  // legitimately references `sessionController` via the frozen §9.1 `inject`
  // list (explicit DI-before-apply — the fix for the historical
  // `sessionController unavailable` class). The no-prompt guard below covers
  // the tool-argument path modules; the managed runtime (`managed-runtime.ts`,
  // `admin-routes.ts`) reaches host APIs only through binding-checked,
  // token-gated adapters — never prompts, never autosubmits.
  it.each(['handler', 'bridge-client', 'session-scope', 'cappi-actions', 'config', 'capabilities', 'pinned-fetch'])(
    'src/%s.ts never prompts, steers, or reads session state',
    (module) => {
      for (const token of FORBIDDEN) {
        expect(src(module), `forbidden token ${token} in ${module}.ts`).not.toContain(token)
      }
    },
  )

  it('src/index.ts injects sessionController explicitly (DI-before-apply)', () => {
    expect(src('index')).toContain('sessionController')
  })
})
