import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

describe('STT-only dictation controller', () => {
  it('delivers Apple Speech finals to the composer draft callback without prompting', async () => {
    const requests: Array<Record<string, unknown>> = []
    installDictateSurface(requests)
    const { dictateController } = await import('../src/client/dictate.ts')
    const finals: string[] = []
    await dictateController.start('session-new', (text) => finals.push(text))
    const lease = dictateRequest(requests, 'session-new')
    expect(lease.clientId).toBeTruthy()

    deliver(dictateController, {
      event: 'dictate-partial', text: 'hel', utteranceId: 'utterance-d1',
      clientId: lease.clientId, leaseId: lease.leaseId, sessionId: 'session-new',
    })
    expect(dictateController.getSnapshot().phase).toBe('hearing')

    deliver(dictateController, {
      event: 'dictate-final', text: 'hello draft', utteranceId: 'utterance-d1',
      clientId: lease.clientId, leaseId: lease.leaseId, sessionId: 'session-new',
    })
    expect(finals).toEqual(['hello draft'])
    expect(dictateController.getSnapshot().phase).toBe('listening')
    expect(requests.some((request) => request.command === 'speak')).toBe(false)

    await dictateController.stop()
    expect(dictateController.getSnapshot().phase).toBe('idle')
  })

  it('ignores finals from a revoked dictation lease', async () => {
    const requests: Array<Record<string, unknown>> = []
    installDictateSurface(requests)
    const { dictateController } = await import('../src/client/dictate.ts')
    const finals: string[] = []
    await dictateController.start('session-new', (text) => finals.push(text))
    const lease = dictateRequest(requests, 'session-new')

    deliver(dictateController, { event: 'ownership-revoked', leaseId: lease.leaseId })
    deliver(dictateController, {
      event: 'dictate-final', text: 'must not insert', utteranceId: 'utterance-late',
      clientId: lease.clientId, leaseId: lease.leaseId, sessionId: 'session-new',
    })
    expect(finals).toEqual([])
  })

  it('returns a stable snapshot identity while state is unchanged', async () => {
    installDictateSurface([])
    const { dictateController } = await import('../src/client/dictate.ts')
    // useSyncExternalStore unmounts entries whose snapshot is a fresh object
    // per read; the mic entry must keep identity until state actually changes.
    expect(dictateController.getSnapshot()).toBe(dictateController.getSnapshot())
  })
})

function installDictateSurface(requests: Array<Record<string, unknown>>): void {
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  vi.stubGlobal('EventSource', class {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    close(): void {}
  })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (typeof init?.body === 'string') requests.push(JSON.parse(init.body) as Record<string, unknown>)
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }))
}

function dictateRequest(requests: Array<Record<string, unknown>>, sessionId: string): { readonly clientId: string; readonly leaseId: string } {
  const request = requests.find((candidate) => candidate.command === 'dictate-start' && candidate.sessionId === sessionId)
  if (!request || typeof request.clientId !== 'string' || typeof request.leaseId !== 'string') throw new Error(`Missing dictate lease for ${sessionId}`)
  return { clientId: request.clientId, leaseId: request.leaseId }
}

function deliver(controller: unknown, event: Record<string, unknown>): void {
  const handler = (controller as unknown as { handleRuntimeMessage(message: Record<string, unknown>): void }).handleRuntimeMessage
  // handleRuntimeMessage is private; reach it structurally like the ownership spec does.
  expect(typeof handler).toBe('function')
  handler.call(controller, event)
}
