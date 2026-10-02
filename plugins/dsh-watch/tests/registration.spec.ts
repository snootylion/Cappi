import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

interface CapturedTool {
  readonly name: string
  readonly description: string
  readonly timeoutMs?: number
  execute(args: unknown, exec: unknown): Promise<unknown>
}

function install(config: Record<string, unknown> = {}): CapturedTool[] {
  const tools: CapturedTool[] = []
  const ctx = {
    tools: {
      register(definition: CapturedTool): () => void {
        tools.push(definition)
        return () => {}
      },
    },
  }
  apply(ctx as never, config as never)
  return tools
}

let servers: Server[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers = []
})

describe('DSH tool registration', () => {
  it('registers cappi_action and the watch_cappi alias', () => {
    const tools = install({ bridgeToken: 't', watchSessionId: 'watch-1' })
    const names = tools.map((tool) => tool.name).sort()
    expect(names).toEqual(['cappi_action', 'watch_cappi'])
    for (const tool of tools) {
      expect(tool.description).toContain('watch-linked session')
      expect(tool.description).toContain('pending')
    }
  })

  it('routes both names through the same watch-session scope', async () => {
    // Scope refusal precedes any network use for both registrations: neither
    // the capabilities GET nor the cappi POST may fire (the pinned transport
    // is never constructed for the wrong session).
    let globalFetches = 0
    vi.stubGlobal('fetch', (async () => {
      globalFetches++
      throw new Error('network must not be used for the wrong session')
    }) as unknown as typeof fetch)
    const tools = install({ watchSessionId: 'watch-1', bridgeToken: 't' })
    expect(tools).toHaveLength(2)
    for (const tool of tools) {
      const result = await tool.execute(
        { action: 'dance' },
        { agent: { id: 'someone-else' }, signal: new AbortController().signal },
      )
      expect(result).toEqual({ ok: false, error: 'not the watch session' })
    }
    expect(globalFetches).toBe(0)
  })

  it('fails closed when the watch session is unconfigured', async () => {
    const tools = install({ bridgeToken: 't' })
    for (const tool of tools) {
      const result = await tool.execute(
        { action: 'dance' },
        { agent: { id: 'watch-1' }, signal: new AbortController().signal },
      )
      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining('watch session is not configured'),
      })
    }
  })

  it('proves caller-session context end to end: exec.agent.id reaches the bridge verbatim', async () => {
    // SDK-level proof: the REAL defineTool registration is driven with mock
    // exec identities shaped like ToolRunContext ({ agent: { id } }). BOTH
    // requests travel the REAL pinned transport to an ephemeral loopback
    // fixture server: the read-only capabilities GET resolves the legacy
    // alias, and the state-changing POST asserts the forwarded sessionId.
    const seenBodies: Record<string, unknown>[] = []
    const seenCaps: string[] = []
    const server = createServer((req, res) => {
      expect(req.headers['x-bridge-token']).toBe('reg-secret')
      if (req.url === '/watch/capabilities') {
        seenCaps.push(req.url)
        res.writeHead(200, { 'content-type': 'application/json' })
        // Explicit-pack example snapshot (stub fixture server): the
        // explicitly selected dot-default pack, NOT the registry default
        // (cappi-original). It exercises the legacy-alias path (dance →
        // celebrate); the default pack is covered by the real-registry E2E.
        res.end(JSON.stringify({
          ok: true,
          version: '0.2.0',
          characterId: 'dot-default',
          characters: ['dot-default', 'ember-min'],
          modelSelectable: ['idle_a', 'idle_b', 'idle_c', 'listen', 'talk_a', 'talk_b', 'work_set', 'celebrate'],
          roles: { talk: ['talk_a', 'talk_b'], celebrate: ['celebrate'] },
        }))
        return
      }
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body) as Record<string, unknown>
        seenBodies.push(parsed)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, action: parsed.action ?? null }))
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (typeof address !== 'object' || !address) throw new Error('no ephemeral port')

    const tools = install({
      bridgeBaseUrl: `http://127.0.0.1:${address.port}`,
      bridgeToken: 'reg-secret',
      watchSessionId: 'watch-1',
    })
    expect(tools).toHaveLength(2)
    for (const tool of tools) {
      const result = await tool.execute(
        { action: 'dance' },
        { agent: { id: 'watch-1' }, signal: new AbortController().signal },
      )
      // dance is a legacy alias: capabilities resolve it to celebrate, and
      // the bridge echo confirms the round-trip.
      expect(result).toEqual({ ok: true, action: 'celebrate' })
    }
    expect(seenBodies).toHaveLength(2)
    for (const body of seenBodies) {
      expect(body).toEqual({ action: 'celebrate', sessionId: 'watch-1' })
    }
    expect(seenCaps).toHaveLength(2)
  })
})
