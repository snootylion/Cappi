import { unlink } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_SETTINGS_PATH } from '../src/voice-settings.ts'
import { KokoroVoiceRuntime, type InputLease, type RuntimeEvent, type VoiceSummaryRequest } from '../src/runtime.ts'

vi.hoisted(() => {
  const temporaryRoot = process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'
  process.env.VOICE_SETTINGS_PATH = `${temporaryRoot}/dsh-live-voice-lifecycle-vitest-${process.pid}-${process.env.VITEST_POOL_ID ?? '0'}.json`
})

// Structural access to the runtime's private lifecycle surface, mirroring the
// style of runtime.spec.ts. Every fake below is in-memory: no helper/TTS
// processes are ever spawned and no loopback servers are bound.
interface LifecycleInternals {
  inputLease?: InputLease | undefined
  dictateLease?: InputLease | undefined
  activeSessionId?: string | undefined
  currentSpeech?: { speechId: string; text: string; kind: 'response'; startedAt?: number; audioDurationMs: number }
  summaryTask?: { readonly id: string; readonly controller: AbortController }
  ownerDisconnectTimer?: NodeJS.Timeout
  clientsById: Map<string, unknown>
  clients: Set<{ end(): void }>
  inputProcess?: { kill(): void; stdin: { writable: boolean } }
  ttsProcess?: { kill(): void; stdin: { writable: boolean } }
  ttsReady?: Promise<void>
  resolveTtsReady?: () => void
  rejectTtsReady?: (error: Error) => void
  ensureInputProcess(): Promise<void>
  ensureTtsReady(): Promise<void>
  startSummary(request: VoiceSummaryRequest): void
  handleTtsLine(line: string): void
  emit(event: RuntimeEvent): void
}

function internalsOf(runtime: KokoroVoiceRuntime): LifecycleInternals {
  return runtime as unknown as LifecycleInternals
}

function fakeClient(writes: unknown[] = []) {
  return {
    destroyed: false,
    writableLength: 0,
    write: (chunk: string) => { writes.push(chunk) },
    end: vi.fn(),
    destroy: vi.fn(),
  }
}

function mockPost(body: unknown, remoteAddress = '127.0.0.1') {
  const payload = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as NodeJS.EventEmitter & {
    method: string
    url: string
    headers: Record<string, string>
    socket: { remoteAddress: string }
  }
  req.method = 'POST'
  req.url = '/dsh-kokoro-live-voice/command'
  req.headers = { 'content-type': 'application/json' }
  req.socket = { remoteAddress }
  ;(req as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* () {
    yield payload
  }
  const res = {
    status: 0,
    body: '',
    destroyed: false,
    writableLength: 0,
    writeHead(status: number) { res.status = status },
    end(chunk?: string) { res.body += chunk ?? '' },
  }
  return { req, res }
}

async function postCommand(runtime: KokoroVoiceRuntime, body: unknown, remoteAddress = '127.0.0.1') {
  const { req, res } = mockPost(body, remoteAddress)
  await runtime.handleCommand(req as never, res as never)
  return { status: res.status, body: JSON.parse(res.body || '{}') as Record<string, unknown> }
}

const LEASE_A: InputLease = { clientId: 'client-a', leaseId: 'lease-a', sessionId: 'session-a' }
const LEASE_B: InputLease = { clientId: 'client-b', leaseId: 'lease-b', sessionId: 'session-b' }

describe('voice runtime lifecycle (one owner, switches, summaries, warm/dispose)', () => {
  beforeEach(async () => { try { await unlink(VOICE_SETTINGS_PATH) } catch { /* start clean */ } })
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    try { await unlink(VOICE_SETTINGS_PATH) } catch { /* leave clean */ }
  })

  it('switches sessions on one runtime: the previous owner is revoked, never shared', async () => {
    const warmSummary = vi.fn(async () => {})
    const releaseSummary = vi.fn()
    const runtime = new KokoroVoiceRuntime({}, console, undefined, warmSummary, releaseSummary)
    await runtime.initialize()
    const io = internalsOf(runtime)
    io.ensureInputProcess = async () => {}
    io.ensureTtsReady = async () => {}
    const writesA: unknown[] = []
    io.clientsById.set('client-a', fakeClient(writesA))
    io.clientsById.set('client-b', fakeClient())

    await runtime.start(LEASE_A)
    expect(io.inputLease).toEqual(LEASE_A)
    // Non-blocking warmup was requested exactly once for the first session.
    await vi.waitFor(() => expect(warmSummary).toHaveBeenCalledTimes(1))

    await runtime.start(LEASE_B)
    expect(io.inputLease).toEqual(LEASE_B)
    expect(writesA.join('')).toContain('ownership-revoked')
    expect(writesA.join('')).toContain('lease-a')

    await runtime.stop(false)
    expect(io.inputLease).toBeUndefined()
    expect(io.activeSessionId).toBeUndefined()
    expect(releaseSummary).toHaveBeenCalledTimes(1)
    await runtime.dispose()
  })

  it('refuses a Live Voice start while dictation owns the helper, and vice versa', async () => {
    const runtime = new KokoroVoiceRuntime({})
    const io = internalsOf(runtime)
    io.ensureInputProcess = async () => {}
    io.dictateLease = { clientId: 'client-d', leaseId: 'lease-d', sessionId: 'session-d' }

    await expect(runtime.start(LEASE_A)).rejects.toThrow('Stop dictation before starting Live Voice.')
    expect(io.inputLease).toBeUndefined()
    expect(io.activeSessionId).toBeUndefined()

    io.dictateLease = undefined
    io.activeSessionId = 'session-a'
    await expect(runtime.dictateStart({ clientId: 'client-d', leaseId: 'lease-d', sessionId: 'session-d' }))
      .rejects.toThrow('End Live Voice before dictating.')
    await runtime.dispose()
  })

  it('enforces single ownership and draft-only dictation at the command boundary', async () => {
    const runtime = new KokoroVoiceRuntime({})
    await runtime.initialize()
    const io = internalsOf(runtime)

    // Unknown command and non-loopback callers are rejected without a lease.
    expect((await postCommand(runtime, { command: 'nope' })).status).toBe(400)
    expect((await postCommand(runtime, { command: 'stop' }, '10.0.0.5')).status).toBe(403)
    // A stale lease cannot stop a session it does not own.
    io.inputLease = LEASE_A
    const staleStop = await postCommand(runtime, { command: 'stop', clientId: 'client-a', leaseId: 'lease-stale' })
    expect(staleStop.status).toBe(409)

    // Live Voice and dictation refuse each other while the other owns input.
    io.dictateLease = { clientId: 'client-d', leaseId: 'lease-d', sessionId: 'session-d' }
    const liveWhileDictating = await postCommand(runtime, { command: 'start', sessionId: 'session-a', clientId: 'client-a', leaseId: 'lease-a' })
    expect(liveWhileDictating.status).toBe(409)
    io.dictateLease = undefined
    io.activeSessionId = 'session-a'
    const dictateWhileLive = await postCommand(runtime, { command: 'dictate-start', sessionId: 'session-d', clientId: 'client-d', leaseId: 'lease-d' })
    expect(dictateWhileLive.status).toBe(409)
    await runtime.dispose()
  })

  it('serializes concurrent summaries: the loser aborts and its late result is dropped', async () => {
    const generations: Array<{
      request: VoiceSummaryRequest
      onDelta: (text: string) => void
      signal: AbortSignal
      resolve: (ok: boolean) => void
    }> = []
    const generateSummary = vi.fn((request: VoiceSummaryRequest, onDelta: (text: string) => void, signal: AbortSignal) => new Promise<boolean>((resolve) => {
      generations.push({ request, onDelta, signal, resolve })
    }))
    const runtime = new KokoroVoiceRuntime({}, console, generateSummary)
    const io = internalsOf(runtime)
    const emitted: RuntimeEvent[] = []
    io.emit = (event: RuntimeEvent) => { emitted.push(event) }

    const first: VoiceSummaryRequest = { summaryId: 'summary-1', responseText: 'First response remainder.', spokenLead: 'Lead one.', userText: 'One?' }
    const second: VoiceSummaryRequest = { summaryId: 'summary-2', responseText: 'Second response remainder.', spokenLead: 'Lead two.', userText: 'Two?' }
    io.startSummary(first)
    expect(generations).toHaveLength(1)
    io.startSummary(second)
    expect(generations).toHaveLength(2)

    // The superseded generation was aborted; its late success emits nothing.
    expect(generations[0]!.signal.aborted).toBe(true)
    expect(generations[1]!.signal.aborted).toBe(false)
    generations[0]!.resolve(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(emitted.filter((event) => event.event === 'summary-done')).toEqual([])

    // The winner streams deltas and completes exactly once.
    generations[1]!.onDelta('Concise result.')
    generations[1]!.resolve(true)
    await vi.waitFor(() => expect(emitted).toContainEqual({ event: 'summary-done', summaryId: 'summary-2', ok: true }))
    expect(emitted.filter((event) => event.event === 'summary-done')).toHaveLength(1)
    expect(emitted).toContainEqual({ event: 'summary-delta', summaryId: 'summary-2', text: 'Concise result.' })
    await runtime.dispose()
  })

  it('rejects a pending TTS warmup when the sidecar reports an error boundary', async () => {
    const runtime = new KokoroVoiceRuntime({})
    const io = internalsOf(runtime)
    const emitted: RuntimeEvent[] = []
    io.emit = (event: RuntimeEvent) => { emitted.push(event) }
    let rejectReady!: (error: Error) => void
    io.ttsReady = new Promise<void>((_resolve, reject) => { rejectReady = reject })
    io.rejectTtsReady = rejectReady
    // Attach the rejection expectation before the sidecar line settles it.
    const settled = expect(io.ttsReady).rejects.toThrow('synthesis backend exploded')

    io.handleTtsLine(JSON.stringify({ event: 'error', message: 'synthesis backend exploded' }))

    await settled
    expect(emitted).toContainEqual(expect.objectContaining({ event: 'audio-cancel' }))
    expect(emitted).toContainEqual(expect.objectContaining({ event: 'state', phase: 'error' }))
    await runtime.dispose()
  })

  it('fails a speaking turn at the sidecar error boundary without leaking the queue', async () => {
    const runtime = new KokoroVoiceRuntime({})
    const io = internalsOf(runtime)
    const emitted: RuntimeEvent[] = []
    io.emit = (event: RuntimeEvent) => { emitted.push(event) }
    io.currentSpeech = { speechId: 'speech-1', text: 'Audible response.', kind: 'response', startedAt: Date.now(), audioDurationMs: 500 }

    io.handleTtsLine(JSON.stringify({ event: 'error', speechId: 'speech-1', message: 'device underrun' }))

    expect(io.currentSpeech).toBeUndefined()
    expect(emitted).toContainEqual({ event: 'audio-cancel', speechId: 'speech-1' })
    expect(emitted).toContainEqual(expect.objectContaining({ event: 'state', phase: 'error' }))
    await runtime.dispose()
  })

  it('disposes exactly once: timers cleared, clients ended, child processes killed', async () => {
    const runtime = new KokoroVoiceRuntime({})
    const io = internalsOf(runtime)
    const client = fakeClient()
    io.clients.add(client as never)
    io.clientsById.set('client-z', client)
    io.ownerDisconnectTimer = setTimeout(() => undefined, 30_000)
    const killInput = vi.fn()
    const killTts = vi.fn()
    io.inputProcess = { kill: killInput, stdin: { writable: false } }
    io.ttsProcess = { kill: killTts, stdin: { writable: false } }

    await runtime.dispose()

    expect(killInput).toHaveBeenCalledTimes(1)
    expect(killTts).toHaveBeenCalledTimes(1)
    expect(client.end).toHaveBeenCalledTimes(1)
    expect(io.clients.size).toBe(0)
    expect(io.clientsById.size).toBe(0)
    expect(io.ownerDisconnectTimer).toBeUndefined()

    // Second dispose is a silent no-op: no double kills, no double ends.
    await runtime.dispose()
    expect(killInput).toHaveBeenCalledTimes(1)
    expect(client.end).toHaveBeenCalledTimes(1)
  })
})
