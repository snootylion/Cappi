import { Context } from '@deepseek-ai/cordis'
import { apply as applyConnection } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'
import { registerVoiceHttpRoutes, SUMMARY_RELEASE_PATH } from '../src/http-routes.ts'
import { COMMAND_PATH, EVENTS_PATH, SETTINGS_PATH, STATUS_PATH, KokoroVoiceRuntime } from '../src/runtime.ts'
import { inject } from '../src/index.ts'

/** Genuine rc.1 Connection authority, genuine WebServer, ephemeral HTTP port.
 * Only credential storage is memory-backed; launch-token exchange mints the
 * real signed authority-bound cookie. No forged cookie or auth predicate. */
async function fixture() {
  const ctx = new Context()
  let stored: unknown
  ctx.provide('credentials', {
    async modifyRecord(_key: unknown, modify: (value: unknown) => Promise<unknown>) {
      const next = await modify(stored)
      if (next !== undefined) stored = next
      return stored
    },
  } as never)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  // Wait for Cordis' async service activation without touching any live port.
  for (let n = 0; !ctx.get('webServer')?.port && n < 100; n++) await new Promise((r) => setTimeout(r, 5))
  await applyConnection(ctx)
  const base = `http://127.0.0.1:${ctx.webServer.port}`
  expect(ctx.webServer.port).not.toBe(0)
  expect([3083, 8787, 8789]).not.toContain(ctx.webServer.port)
  ctx.webServer.register({ kind: 'exact', path: '/', handler: (req, res) => {
    if (ctx.connection.authorizeIndex(req, res)) { res.writeHead(200); res.end('index') }
  } })
  const exchange = await fetch(ctx.connection.authenticatedUrl(base), { redirect: 'manual' })
  expect(exchange.status).toBe(303)
  const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!
  return { ctx, base, cookie }
}

const paths = [EVENTS_PATH, COMMAND_PATH, SETTINGS_PATH, STATUS_PATH, SUMMARY_RELEASE_PATH]
const methodFor = (route: string) => route === COMMAND_PATH || route === SUMMARY_RELEASE_PATH ? 'POST' : 'GET'

describe('all external voice routes use the real DSH connection gate', () => {
  it('requires the rc.1 connection service without a local bypass', () => {
    expect(inject).toContain('connection')
  })
  it('returns 401 anonymous, 403 foreign Origin and authenticated success before any backend dispatch', async () => {
    const { ctx, base, cookie } = await fixture()
    const backend = vi.fn(async (_req, res) => { res.writeHead(200); res.end('{"ok":true}') })
    const status = vi.fn(() => ({ ok: true }))
    const release = vi.fn(async () => undefined)
    const dispose = registerVoiceHttpRoutes(ctx, {
      attachEvents: backend, handleCommand: backend, handleSettings: backend,
      status: () => ({ event: 'state', phase: 'idle', active: false, muted: false }),
    }, status, release)
    try {
      for (const route of paths) {
        const method = methodFor(route)
        const request = { method, ...(method === 'POST' ? { body: '{}' } : {}) }
        for (const headers of [
          { 'content-type': 'application/json' },
          { 'content-type': 'application/json', cookie, origin: 'https://foreign.example' },
        ]) {
          const response = await fetch(base + route, { ...request, headers })
          expect(response.status, route).toBe('origin' in headers ? 403 : 401)
          await response.text()
          expect(backend).not.toHaveBeenCalled(); expect(status).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled()
        }
      }
      for (const route of paths) {
        const method = methodFor(route)
        const response = await fetch(base + route, { method, headers: { cookie, origin: base, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) })
        expect(response.status, route).toBe(200); await response.text()
      }
      expect(backend).toHaveBeenCalledTimes(3); expect(status).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce()
    } finally { dispose.forEach((fn) => fn()); await ctx.fiber.dispose() }
  })

  it('gates malformed requests first; authenticated mutations reject wrong type, duplicate keys and oversized JSON', async () => {
    const { ctx, base, cookie } = await fixture()
    const runtime = new KokoroVoiceRuntime({})
    const release = vi.fn(async () => undefined)
    const dispose = registerVoiceHttpRoutes(ctx, runtime, () => runtime.status(), release)
    try {
      for (const route of [COMMAND_PATH, SETTINGS_PATH, SUMMARY_RELEASE_PATH]) {
        for (const [type, body, code] of [
          ['text/plain', '{}', 415],
          ['application/json', '{"command":"stop","command":"start"}', 400],
          ['application/json', '{"patch":{"voice":"a","vo\\u0069ce":"b"}}', 400],
          ['application/json', JSON.stringify({ text: 'x'.repeat(65536) }), 413],
        ] as const) {
          const anonymous = await fetch(base + route, { method: 'POST', headers: { 'content-type': type }, body })
          expect(anonymous.status).toBe(401); await anonymous.text()
          const response = await fetch(base + route, { method: 'POST', headers: { cookie, origin: base, 'content-type': type }, body })
          expect(response.status, route).toBe(code); await response.text()
        }
      }
      expect(release).not.toHaveBeenCalled()
    } finally { dispose.forEach((fn) => fn()); await runtime.dispose(); await ctx.fiber.dispose() }
  })
})
