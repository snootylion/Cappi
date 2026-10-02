import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LiveVoiceController, type VoiceConversationSnapshot } from '../src/client/controller.ts'

afterEach(() => vi.unstubAllGlobals())

describe('input ownership across Harness surfaces', () => {
  it('submits a duplicated final to exactly one target session and one main prompt', async () => {
    const requests: Array<Record<string, unknown>> = []
    installHarnessSurface(requests)
    const first = fakeSession('session-first')
    const second = fakeSession('session-second')
    const firstController = new LiveVoiceController()
    const secondController = new LiveVoiceController()

    await firstController.start(first.session, first.snapshot)
    await secondController.start(second.session, second.snapshot)
    const firstLease = startRequest(requests, 'session-first')
    const event = {
      event: 'final', text: 'route this once', utteranceId: 'utterance-shared',
      clientId: firstLease.clientId, leaseId: firstLease.leaseId, sessionId: 'session-first',
    }
    deliver(firstController, event)
    deliver(firstController, event) // reconnect/replay race
    deliver(secondController, event) // concurrent background surface
    await Promise.resolve()

    expect(first.prompt).toHaveBeenCalledTimes(1)
    expect(second.prompt).not.toHaveBeenCalled()
    expect(requests.filter((request) => request.command === 'holding' && request.clientId === firstLease.clientId)).toHaveLength(1)
    expect(requests.filter((request) => request.command === 'holding')).toHaveLength(1)
  })

  it('rejects a late final after its ownership lease is revoked', async () => {
    const requests: Array<Record<string, unknown>> = []
    installHarnessSurface(requests)
    const target = fakeSession('session-stale')
    const controller = new LiveVoiceController()
    await controller.start(target.session, target.snapshot)
    const lease = startRequest(requests, 'session-stale')

    deliver(controller, { event: 'ownership-revoked', leaseId: lease.leaseId })
    deliver(controller, {
      event: 'final', text: 'must not submit', utteranceId: 'utterance-late',
      clientId: lease.clientId, leaseId: lease.leaseId, sessionId: 'session-stale',
    })
    await Promise.resolve()

    expect(target.prompt).not.toHaveBeenCalled()
  })

  it('keeps one client identity across an event-stream reconnect', async () => {
    const requests: Array<Record<string, unknown>> = []
    const eventUrls: string[] = []
    installHarnessSurface(requests, eventUrls)
    const target = fakeSession('session-reconnect')
    const controller = new LiveVoiceController()
    await controller.start(target.session, target.snapshot)
    const lease = startRequest(requests, 'session-reconnect')

    ;(controller as unknown as { ensureEvents(): void }).ensureEvents()

    expect(eventUrls).toHaveLength(2)
    expect(eventUrls.map((url) => new URL(url, 'http://localhost').searchParams.get('clientId'))).toEqual([lease.clientId, lease.clientId])
  })

  it('accepts only a client-validated 4–12 word holding phrase without another session prompt', async () => {
    const requests: Array<Record<string, unknown>> = []
    installHarnessSurface(requests)
    const target = fakeSession('session-holding')
    const controller = new LiveVoiceController()
    await controller.start(target.session, target.snapshot)
    const lease = startRequest(requests, 'session-holding')

    deliver(controller, {
      event: 'holding-ready', requestId: 'holding-safe', text: 'Let me review that carefully.', source: 'local-mlx',
      clientId: lease.clientId, leaseId: lease.leaseId, sessionId: 'session-holding',
    })
    deliver(controller, {
      event: 'holding-ready', requestId: 'holding-unsafe', text: 'The answer is definitely ready now.', source: 'local-mlx',
      clientId: lease.clientId, leaseId: lease.leaseId, sessionId: 'session-holding',
    })
    await Promise.resolve()

    expect(requests.filter((request) => request.command === 'accept-holding')).toEqual([
      expect.objectContaining({ requestId: 'holding-safe', clientId: lease.clientId }),
    ])
    expect(target.prompt).not.toHaveBeenCalled()
  })
})

function installHarnessSurface(requests: Array<Record<string, unknown>>, eventUrls: string[] = []): void {
  vi.stubGlobal('window', {
    webkit: { messageHandlers: { kokoroVoice: { postMessage: vi.fn() } } },
    setTimeout,
    clearTimeout,
  })
  vi.stubGlobal('EventSource', class {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    constructor(url: string | URL) { eventUrls.push(String(url)) }
    close(): void {}
  })
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (typeof init?.body === 'string') requests.push(JSON.parse(init.body) as Record<string, unknown>)
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }))
}

function fakeSession(sessionId: string): {
  readonly session: SessionFace
  readonly snapshot: VoiceConversationSnapshot
  readonly prompt: ReturnType<typeof vi.fn>
} {
  const prompt = vi.fn(async () => ({ ok: true }))
  const snapshot = {
    running: false,
    runningCalls: [],
    partial: null,
    nodes: [],
    turnEnds: new Map(),
    turnTimings: new Map(),
  } as unknown as VoiceConversationSnapshot
  const session = {
    sessionId,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    prompt,
  } as unknown as SessionFace
  return { session, snapshot, prompt }
}

function startRequest(requests: Array<Record<string, unknown>>, sessionId: string): { readonly clientId: string; readonly leaseId: string } {
  const request = requests.find((candidate) => candidate.command === 'start' && candidate.sessionId === sessionId)
  if (!request || typeof request.clientId !== 'string' || typeof request.leaseId !== 'string') throw new Error(`Missing start lease for ${sessionId}`)
  return { clientId: request.clientId, leaseId: request.leaseId }
}

function deliver(controller: LiveVoiceController, event: Record<string, unknown>): void {
  ;(controller as unknown as { handleRuntimeMessage(message: Record<string, unknown>): void }).handleRuntimeMessage(event)
}
