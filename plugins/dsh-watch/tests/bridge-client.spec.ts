import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_TOKEN_HEADER,
  postWatchAction,
  readBridgeToken,
  type BridgeFetch,
} from '../src/bridge-client.ts'
import { DEFAULT_BRIDGE_BASE_URL, resolveWatchConfig } from '../src/config.ts'

let servers: Server[] = []
let tempDirs: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-watch-test-'))
  tempDirs.push(dir)
  return dir
}

function tokenConfig(
  token: string | undefined,
  overrides: Record<string, unknown> = {},
  dir = tempDir(),
) {
  const tokenPath = path.join(dir, 'token')
  if (token !== undefined) writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 })
  return resolveWatchConfig({
    // Explicit loopback http for stub-transport tests: the secure default is
    // https+pin (fail-closed), so unit stubs pin an explicit local target
    // instead of depending on ambient DSH_WATCH_* env.
    bridgeBaseUrl: 'http://127.0.0.1:8787',
    bridgeTokenPath: tokenPath,
    watchSessionId: 'watch-1',
    ...overrides,
  })
}

function stubFetch(handler: (url: string, init: Parameters<BridgeFetch>[1]) => unknown): BridgeFetch {
  return (async (url: string, init: Parameters<BridgeFetch>[1]) => handler(url, init)) as BridgeFetch
}

describe('bridge token handling', () => {
  it('reads the token from a file and trims it', async () => {
    const config = tokenConfig('secret-token')
    await expect(readBridgeToken(config)).resolves.toBe('secret-token')
  })

  it('reports a missing token instead of throwing', async () => {
    const config = tokenConfig(undefined)
    const result = await postWatchAction(config, 'dance', 'watch-1', stubFetch(() => {
      throw new Error('must not be called without a token')
    }))
    expect(result).toEqual({ ok: false, error: 'bridge token is not configured' })
  })
})

describe('bridge POST contract', () => {
  it('sends the token in the header, never in the URL', async () => {
    let seenUrl = ''
    let seenHeaders: Record<string, string> = {}
    let seenBody = ''
    const fetchImpl = stubFetch((url, init) => {
      seenUrl = url
      seenHeaders = init.headers
      seenBody = String(init.body)
      return { ok: true, status: 200, json: async () => ({ ok: true, action: 'dance' }) }
    })
    const result = await postWatchAction(tokenConfig('header-secret'), 'dance', 'watch-1', fetchImpl)
    expect(result).toEqual({ ok: true, action: 'dance' })
    expect(seenUrl).toBe('http://127.0.0.1:8787/watch/cappi')
    expect(seenUrl).not.toContain('header-secret')
    expect(seenHeaders[BRIDGE_TOKEN_HEADER]).toBe('header-secret')
    expect(JSON.parse(seenBody)).toEqual({ action: 'dance', sessionId: 'watch-1' })
  })

  it('maps clear to a null bridge action', async () => {
    const fetchImpl = stubFetch((_url, init) => {
      expect(JSON.parse(String(init.body))).toEqual({ action: null, sessionId: 'watch-1' })
      return { ok: true, status: 200, json: async () => ({ ok: true, action: null }) }
    })
    await expect(postWatchAction(tokenConfig('t'), null, 'watch-1', fetchImpl)).resolves.toEqual({
      ok: true,
      action: null,
    })
  })

  it('surfaces bridge rejections as results, not exceptions', async () => {
    const fetchImpl = stubFetch(() => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: 'unknown action: nope' }),
    }))
    await expect(postWatchAction(tokenConfig('t'), 'dance', 'watch-1', fetchImpl)).resolves.toEqual({
      ok: false,
      error: 'unknown action: nope',
    })
  })

  it('maps network failures and timeouts to results', async () => {
    const failing = stubFetch(() => {
      throw new Error('socket hang up')
    })
    const failed = await postWatchAction(tokenConfig('t'), 'dance', 'watch-1', failing)
    expect(failed.ok).toBe(false)
    expect(failed).toMatchObject({ ok: false })
    if (!failed.ok) expect(failed.error).toContain('socket hang up')

    const aborting = stubFetch((_url, init) => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      void init.signal
      throw error
    })
    await expect(postWatchAction(tokenConfig('t'), 'dance', 'watch-1', aborting)).resolves.toEqual({
      ok: false,
      error: 'bridge request timed out',
    })
  })

  it('rejects non-loopback http without explicit opt-in', async () => {
    const fetchImpl = stubFetch(() => {
      throw new Error('must not call the network')
    })
    const config = tokenConfig('t', { bridgeBaseUrl: 'http://192.0.2.10:8787' })
    const result = await postWatchAction(config, 'dance', 'watch-1', fetchImpl)
    expect(result.ok).toBe(false)
  })

  it('requires the caller session id for the bridge binding', async () => {
    const fetchImpl = stubFetch(() => {
      throw new Error('must not be called without a session id')
    })
    await expect(postWatchAction(tokenConfig('t'), 'dance', '', fetchImpl)).resolves.toEqual({
      ok: false,
      error: 'calling session id is required for the bridge session binding',
    })
  })

  it('refuses the secure default without a pin (fail-closed, no downgrade, no token sent)', async () => {
    const fetchImpl = stubFetch(() => {
      throw new Error('must not call the network')
    })
    // Neutralize ambient overrides: the secure default must resolve to
    // loopback https with an empty pin regardless of the operator shell.
    vi.stubEnv('DSH_WATCH_BRIDGE_URL', '')
    vi.stubEnv('DSH_WATCH_BRIDGE_PIN', '')
    const dir = tempDir()
    const tokenPath = path.join(dir, 'token')
    writeFileSync(tokenPath, 't\n', { mode: 0o600 })
    const config = resolveWatchConfig({ bridgeTokenPath: tokenPath, watchSessionId: 'watch-1' })
    expect(DEFAULT_BRIDGE_BASE_URL).toBe('https://127.0.0.1:8787')
    expect(config.bridgeBaseUrl).toBe('https://127.0.0.1:8787')
    const result = await postWatchAction(config, 'dance', 'watch-1', fetchImpl)
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('bridge pin is not configured'),
    })
  })

  it('refuses https targets without a pin (fail-closed, no downgrade)', async () => {
    const fetchImpl = stubFetch(() => {
      throw new Error('must not call the network')
    })
    const config = tokenConfig('t', { bridgeBaseUrl: 'https://bridge.example:8787' })
    const result = await postWatchAction(config, 'dance', 'watch-1', fetchImpl)
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('bridge pin is not configured'),
    })
  })

  it('round-trips against a loopback fixture server on an ephemeral port', async () => {
    const server = createServer((req, res) => {
      expect(req.headers[BRIDGE_TOKEN_HEADER]).toBe('ephemeral-secret')
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, action: JSON.parse(body).action ?? null }))
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address !== 'object' || !address) throw new Error('no ephemeral port')
    const config = tokenConfig('ephemeral-secret', {
      bridgeBaseUrl: `http://127.0.0.1:${address.port}`,
    })
    const result = await postWatchAction(config, 'work', 'watch-1')
    expect(result).toEqual({ ok: true, action: 'work' })
  })
})
