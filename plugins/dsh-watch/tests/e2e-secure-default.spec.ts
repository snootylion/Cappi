import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
// Real bridge ESM modules (actual TLS server factory + production router).
// The bridge ships .mjs without type declarations; each import is
// individually ignored so src strictness is untouched.
// @ts-ignore: bridge .mjs has no type declarations (runtime import only)
import { createBridgeServer, certSha256Pin } from '../../../bridge/tls.mjs'
// @ts-ignore: bridge .mjs has no type declarations (runtime import only)
import { queryHasToken, tokenOkTimingSafe } from '../../../bridge/auth.mjs'
// @ts-ignore: bridge .mjs has no type declarations (runtime import only)
import { createCharacterStore, parseCharacterRegistry } from '../../../bridge/characters.mjs'
// @ts-ignore: bridge .mjs has no type declarations (runtime import only)
import { createWatchActions } from '../../../bridge/watch-actions.mjs'
// @ts-ignore: bridge .mjs has no type declarations (runtime import only)
import { decideSetPermissionTarget } from '../../../bridge/bridge.mjs'
import { resolveWatchConfig } from '../src/config.ts'
import { fetchCapabilities, resolveActionCapability } from '../src/capabilities.ts'
import { postWatchAction } from '../src/bridge-client.ts'

const TOKEN = 'e2e-secure-default-token'
const REGISTRY_PATH = path.resolve(import.meta.dirname, '../../../characters/registry.json')

let tempDir = ''
let server: ReturnType<typeof createBridgeServer> | null = null
let port = 0
let pin = ''
let watched = 'sess-A'
let cappiAction: string | null = null
let sse: unknown[] = []
let requests = 0
// Mock harness RPC for set-permission: records calls to prove 409 precedes
// any real effect (a rejected binding must leave zero calls).
let permissionCalls: Array<{ sessionId: string; preset: string }> = []

function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  // Scrub ambient DSH_/BRIDGE_ so operator-shell fixtures can never
  // redirect the ephemeral bridge under test. Explicit values win.
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^DSH_/u.test(key) || /^BRIDGE_/u.test(key)) continue
    if (value !== undefined) env[key] = value
  }
  return { ...env, ...extra }
}

function json(res: { writeHead(n: number, h: Record<string, string>): void; end(b: string): void }, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readJson(req: { on(e: string, cb: (d?: Buffer) => void): void }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    req.on('data', (d) => { if (d) parts.push(d) })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')) }
      catch { reject(new Error('bad json')) }
    })
    req.on('error', reject)
  })
}

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'dsh-watch-e2e-'))
  const cert = path.join(tempDir, 'bridge-cert.pem')
  const key = path.join(tempDir, 'bridge-key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes',
    '-keyout', key, '-out', cert, '-subj', '/CN=e2e-secure-default'], {
    stdio: 'pipe',
    env: scrubbedEnv(),
  })
  const certPem = readFileSync(cert, 'utf8')
  pin = certSha256Pin(certPem)

  const parsed = parseCharacterRegistry(JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')))
  if (!parsed.ok) throw new Error(`registry invalid: ${(parsed as { error: string }).error}`)
  const registry = (parsed as { registry: Parameters<typeof createWatchActions>[0]['registry'] }).registry
  const chars = createCharacterStore({ registry })
  const actions = createWatchActions({
    getWatchedSession: () => watched,
    chars,
    registry,
    getCappiAction: () => cappiAction,
    setCappiAction: (a: string | null) => { cappiAction = a },
    notify: (o: unknown) => { sse.push(o) },
  })

  const handler = async (req: { url?: string; method?: string; headers: Record<string, string | string[] | undefined>; on(e: string, cb: (d?: never) => void): void }, res: Parameters<typeof json>[0]) => {
    requests++
    const url = new URL(req.url ?? '/', 'https://x')
    if (queryHasToken(url)) return json(res, 401, { ok: false, error: 'token in URL is rejected' })
    const header = req.headers['x-bridge-token']
    const provided = Array.isArray(header) ? header[0] : header
    if (!tokenOkTimingSafe(provided ?? null, TOKEN)) return json(res, 401, { ok: false, error: 'bad token' })
    try {
      if (url.pathname === '/watch/capabilities' && req.method === 'GET') {
        return json(res, 200, actions.describeCapabilities())
      }
      if (url.pathname === '/watch/cappi' && req.method === 'POST') {
        const out = actions.handleCappiBody(await readJson(req as never))
        return json(res, out.status, out.payload)
      }
      return json(res, 404, { ok: false, error: 'not found' })
    } catch (e) {
      return json(res, 500, { ok: false, error: (e as Error).message })
    }
  }

  server = createBridgeServer({ handler: handler as never, tls: { cert: certPem, key: readFileSync(key, 'utf8') } })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
}, 30_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

function secureConfig(pinValue = pin) {
  vi.stubEnv('DSH_WATCH_BRIDGE_URL', '')
  vi.stubEnv('DSH_WATCH_BRIDGE_PIN', '')
  vi.stubEnv('DSH_WATCH_BRIDGE_TOKEN', '')
  return resolveWatchConfig({
    bridgeBaseUrl: `https://127.0.0.1:${port}`,
    bridgeToken: TOKEN,
    bridgeCertPin: pinValue,
    watchSessionId: 'sess-A',
  })
}

describe('secure-default E2E (real TLS server + real plugin client, ephemeral loopback)', () => {
  it('the secure default path connects: capabilities + action round-trip over the pinned transport', async () => {
    const config = secureConfig()
    // No fetchImpl: fetchCapabilities/postWatchAction use the REAL pinned
    // transport (pin verified pre-token, redirects refused). The bridge
    // serves the REAL canonical registry, whose default is cappi-original.
    const caps = await fetchCapabilities(config)
    expect(caps.ok).toBe(true)
    if (!caps.ok) return
    expect(caps.capabilities.characterId).toBe('cappi-original')
    expect(caps.capabilities.modelSelectable).toContain('talk2')
    expect(caps.capabilities.modelSelectable).toContain('shadow')
    // Consumer parity: the plugin consumes exactly what the bridge router
    // publishes (ids, characters, roles) with no fabricated state.
    // On the default pack legacy ids are direct hits (shadow is
    // model-selectable on cappi-original).
    const resolved = resolveActionCapability('shadow', caps.capabilities)
    expect(resolved).toEqual({ ok: true, action: 'shadow' })
    const posted = await postWatchAction(config, 'shadow', 'sess-A')
    expect(posted).toEqual({ ok: true, action: 'shadow' })
    expect(cappiAction).toBe('shadow')
  })

  it('fail-closed without a pin: no token sent, server sees no new request', async () => {
    const seen = requests
    const config = secureConfig('')
    const caps = await fetchCapabilities(config)
    expect(caps).toEqual({ ok: false, error: expect.stringContaining('bridge pin is not configured') })
    const posted = await postWatchAction(config, 'talk2', 'sess-A')
    expect(posted).toEqual({ ok: false, error: expect.stringContaining('bridge pin is not configured') })
    expect(requests).toBe(seen)
  })

  it('wrong pin fails closed before any token is sent', async () => {
    const seen = requests
    const config = secureConfig(Buffer.alloc(32, 7).toString('base64'))
    await expect(fetchCapabilities(config)).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    )
    expect(requests).toBe(seen)
  })

  it('session binding over the real client: 409 leaves state untouched, correct call applies', async () => {
    const config = secureConfig()
    cappiAction = null
    sse = []
    // Default-pack (cappi-original) vocabulary throughout: this E2E drives
    // the registry default, never an assumed pack.
    const missing = await postWatchAction(config, 'talk2', '')
    expect(missing).toEqual({ ok: false, error: expect.stringContaining('calling session id is required') })
    const intruder = await postWatchAction(config, 'talk2', 'sess-B')
    expect(intruder.ok).toBe(false)
    if (!intruder.ok) expect(intruder.error).toMatch(/watched session/)
    expect(cappiAction).toBe(null)
    expect(sse).toEqual([])
    const good = await postWatchAction(config, 'talk2', 'sess-A')
    expect(good).toEqual({ ok: true, action: 'talk2' })
    // Stale caller after a session switch is rejected with no effect.
    watched = 'sess-B'
    const stale = await postWatchAction(config, 'idle1_a', 'sess-A')
    expect(stale.ok).toBe(false)
    expect(cappiAction).toBe('talk2')
    const fresh = await postWatchAction(config, 'idle1_a', 'sess-B')
    expect(fresh).toEqual({ ok: true, action: 'idle1_a' })
    watched = 'sess-A'
  })

  it('set-permission binding: mismatch 409 precedes any harness RPC', async () => {
    permissionCalls = []
    const fakeSetPermission = async (sessionId: string, preset: string) => {
      permissionCalls.push({ sessionId, preset })
      return { ok: true, preset, text: null }
    }
    // Pinned-A / active-B (R-05): the captured watched id wins, the caller
    // loses, and the RPC never runs.
    const mismatch = decideSetPermissionTarget({ sessionId: 'sess-A', preset: 'default' }, 'sess-B')
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.status).toBe(409)
    expect(permissionCalls).toEqual([])
    // Correct binding dispatches against the CAPTURED id.
    const good = decideSetPermissionTarget({ sessionId: 'sess-A', preset: 'default' }, 'sess-A')
    expect(good).toEqual({ ok: true, sessionId: 'sess-A' })
    if (good.ok) await fakeSetPermission(good.sessionId, 'default')
    expect(permissionCalls).toEqual([{ sessionId: 'sess-A', preset: 'default' }])
    // Missing caller id → 400, never dispatched.
    expect(decideSetPermissionTarget({ preset: 'default' }, 'sess-A').ok).toBe(false)
    expect(permissionCalls).toHaveLength(1)
  })
})
