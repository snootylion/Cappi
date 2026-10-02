import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unlink } from 'node:fs/promises'
import { VOICE_SETTINGS_PATH } from '../src/voice-settings.ts'
import { InputUtteranceGate, isLikelyPlaybackEcho, KokoroVoiceRuntime, ownsInputLease, resolveVoiceConfig, runtimeEventRecipients, sameInputLease, type RuntimeEvent } from '../src/runtime.ts'

vi.hoisted(() => {
  const temporaryRoot = process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'
  process.env.VOICE_SETTINGS_PATH = `${temporaryRoot}/dsh-live-voice-kokoro-vitest-${process.pid}-${process.env.VITEST_POOL_ID ?? '0'}.json`
})

const ROOT = path.resolve(import.meta.dirname, '..')
const FIXTURE_RUNTIME = path.join(import.meta.dirname, 'fixtures', 'voice', 'kokoro')

describe('Kokoro runtime configuration', () => {
  beforeEach(async () => { try { await unlink(VOICE_SETTINGS_PATH) } catch { /* start clean */ } })
  afterEach(async () => { vi.unstubAllEnvs(); try { await unlink(VOICE_SETTINGS_PATH) } catch { /* leave clean for sibling suites */ } })
  it('targets transcripts and summary events only to the authoritative input owner', () => {
    const owner = { id: 'owner' }
    const staleSurface = { id: 'stale' }
    const observer = { id: 'observer' }
    const clients = new Set([owner, staleSurface, observer])
    const interactive = new Set([owner, staleSurface])
    const native = new Set([owner, observer])
    const final: RuntimeEvent = {
      event: 'final', text: 'one utterance', utteranceId: 'utterance-1',
      clientId: 'client-owner', leaseId: 'lease-owner', sessionId: 'session-owner',
    }

    expect(runtimeEventRecipients(final, clients, interactive, native, owner)).toEqual([owner])
    expect(runtimeEventRecipients({ event: 'speech-started', speechId: 'speech-1', clientTag: 'opening-1' }, clients, interactive, native, owner)).toEqual([owner])
    expect(runtimeEventRecipients({ event: 'summary-delta', summaryId: 'summary-1', text: 'done' }, clients, interactive, native, owner)).toEqual([owner])
    expect(runtimeEventRecipients(final, clients, interactive, native)).toEqual([])
  })

  it('deduplicates repeated final events from one microphone utterance', () => {
    const gate = new InputUtteranceGate()
    const utteranceId = gate.start()

    expect(gate.current()).toBe(utteranceId)
    expect(gate.finalize()).toBe(utteranceId)
    expect(gate.finalize()).toBeUndefined()
    expect(gate.start()).not.toBe(utteranceId)
  })

  it('rejects speaker-loopback transcripts while preserving spoken interruptions', () => {
    const output = ['The deployment is ready now, and the next validation can begin.']
    expect(isLikelyPlaybackEcho('The deployment is ready now, and the next validation can begin.', output)).toBe(true)
    expect(isLikelyPlaybackEcho('deployment is ready now', output)).toBe(true)
    const combinedOutput = [
      'I am checking the echo fix: did you say what?',
      'If yes, the interruption works.',
    ].join(' ')
    expect(isLikelyPlaybackEcho('I am checking the echo fix did you say what if yes the interruption works', [combinedOutput])).toBe(true)
    expect(isLikelyPlaybackEcho('Stop, use the backup instead.', output)).toBe(false)
    expect(isLikelyPlaybackEcho('Actually use the backup instead.', output)).toBe(false)
    expect(isLikelyPlaybackEcho('Please wait, I want to change that.', output)).toBe(false)
  })

  it('keeps playback running for echo but cancels it for a genuine barge-in', () => {
    const runtime = new KokoroVoiceRuntime({})
    const cancelSpeech = vi.fn()
    const emit = vi.fn()
    const internals = runtime as unknown as {
      activeSessionId?: string
      inputLease?: { clientId: string; leaseId: string; sessionId: string }
      currentSpeech?: { speechId: string; text: string; kind: 'response'; startedAt: number; audioDurationMs: number }
      cancelSpeech(): void
      emit(event: RuntimeEvent): void
      setPhase(phase: string): void
      handleInputLine(line: string): void
    }
    internals.activeSessionId = 'session-a'
    internals.inputLease = { clientId: 'client-a', leaseId: 'lease-a', sessionId: 'session-a' }
    internals.currentSpeech = {
      speechId: 'speech-a',
      text: 'The deployment is ready now, and the next validation can begin.',
      kind: 'response',
      startedAt: Date.now(),
      audioDurationMs: 1_000,
    }
    internals.cancelSpeech = cancelSpeech
    internals.emit = emit
    internals.setPhase = vi.fn()
    internals.handleInputLine(JSON.stringify({ event: 'speechStarted' }))
    internals.handleInputLine(JSON.stringify({ event: 'partial', text: 'the deployment is ready now' }))
    expect(cancelSpeech).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()

    internals.handleInputLine(JSON.stringify({ event: 'partial', text: 'Actually use the backup instead' }))
    expect(cancelSpeech).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'partial', text: 'Actually use the backup instead' }))
  })

  it('drops microphone transcripts while muted without leaving the muted phase', () => {
    const runtime = new KokoroVoiceRuntime({})
    const emit = vi.fn()
    const setPhase = vi.fn()
    const internals = runtime as unknown as {
      activeSessionId?: string
      muted: boolean
      inputLease?: { clientId: string; leaseId: string; sessionId: string }
      cancelSpeech(): void
      emit(event: RuntimeEvent): void
      setPhase(phase: string): void
      handleInputLine(line: string): void
    }
    internals.activeSessionId = 'session-muted'
    internals.muted = true
    internals.inputLease = { clientId: 'client-muted', leaseId: 'lease-muted', sessionId: 'session-muted' }
    internals.cancelSpeech = vi.fn()
    internals.emit = emit
    internals.setPhase = setPhase
    internals.handleInputLine(JSON.stringify({ event: 'partial', text: 'Keep listening while muted' }))
    internals.handleInputLine(JSON.stringify({ event: 'final', text: 'Keep listening while muted' }))
    expect(emit).not.toHaveBeenCalled()
    expect(setPhase).not.toHaveBeenCalled()
    expect(internals.muted).toBe(true)

    internals.muted = false
    internals.handleInputLine(JSON.stringify({ event: 'partial', text: 'Keep listening while muted' }))
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'partial', text: 'Keep listening while muted' }))
  })

  it('treats client, lease, and target session as one indivisible ownership key', () => {
    const lease = { clientId: 'client-a', leaseId: 'lease-a', sessionId: 'session-a' }
    expect(sameInputLease(lease, { ...lease })).toBe(true)
    expect(sameInputLease(lease, { ...lease, clientId: 'client-b' })).toBe(false)
    expect(sameInputLease(lease, { ...lease, leaseId: 'lease-b' })).toBe(false)
    expect(sameInputLease(lease, { ...lease, sessionId: 'session-b' })).toBe(false)
    expect(ownsInputLease(lease, { clientId: 'client-a', leaseId: 'lease-a', sessionId: 'session-a' })).toBe(true)
    expect(ownsInputLease(lease, { clientId: 'client-a', leaseId: 'stale-lease', sessionId: 'session-a' })).toBe(false)
    expect(ownsInputLease(lease, { clientId: 'client-a', leaseId: 'lease-a', sessionId: 'stale-session' })).toBe(false)
  })

  it('routes dictation transcripts only to the dictation owner, never the Live Voice owner', () => {
    const liveOwner = { id: 'live-owner' }
    const dictateOwner = { id: 'dictate-owner' }
    const observer = { id: 'observer' }
    const clients = new Set([liveOwner, dictateOwner, observer])
    const interactive = new Set([liveOwner, dictateOwner])
    const native = new Set([observer])
    const dictateFinal: RuntimeEvent = {
      event: 'dictate-final', text: 'hello draft', utteranceId: 'utterance-d1',
      clientId: 'client-d', leaseId: 'lease-d', sessionId: 'session-d',
    }

    expect(runtimeEventRecipients(dictateFinal, clients, interactive, native, liveOwner, dictateOwner)).toEqual([dictateOwner])
    expect(runtimeEventRecipients(dictateFinal, clients, interactive, native, liveOwner)).toEqual([])
    expect(runtimeEventRecipients({
      event: 'dictate-partial', text: 'hel', utteranceId: 'utterance-d1',
      clientId: 'client-d', leaseId: 'lease-d', sessionId: 'session-d',
    }, clients, interactive, native, liveOwner, dictateOwner)).toEqual([dictateOwner])
  })

  it('forwards Apple Speech finals to the composer draft path while Live Voice stays idle', () => {
    const runtime = new KokoroVoiceRuntime({})
    const emit = vi.fn()
    const internals = runtime as unknown as {
      activeSessionId: string | undefined
      dictateLease?: { clientId: string; leaseId: string; sessionId: string }
      cancelSpeech(): void
      emit(event: RuntimeEvent): void
      setPhase(phase: string): void
      handleInputLine(line: string): void
    }
    internals.activeSessionId = undefined
    internals.dictateLease = { clientId: 'client-d', leaseId: 'lease-d', sessionId: 'session-new' }
    internals.cancelSpeech = vi.fn()
    internals.emit = emit
    internals.setPhase = vi.fn()
    internals.handleInputLine(JSON.stringify({ event: 'speechStarted' }))
    internals.handleInputLine(JSON.stringify({ event: 'partial', text: 'hello draft' }))
    internals.handleInputLine(JSON.stringify({ event: 'final', text: 'hello draft' }))
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'dictate-partial', text: 'hello draft' }))
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'dictate-final', text: 'hello draft' }))
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'partial' }))
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'final' }))
    expect(internals.cancelSpeech).not.toHaveBeenCalled()
    expect(internals.setPhase).not.toHaveBeenCalled()
  })

  it('routes PCM to one native owner instead of echoing through every open Harness client', () => {
    const dock = { id: 'dock' }
    const secondDockObserver = { id: 'dock-duplicate' }
    const activeBrowser = { id: 'browser-active' }
    const backgroundBrowser = { id: 'browser-background' }
    const clients = new Set([dock, secondDockObserver, activeBrowser, backgroundBrowser])
    const interactive = new Set([activeBrowser, backgroundBrowser])
    const native = new Set([dock, secondDockObserver])
    const audio: RuntimeEvent = {
      event: 'audio', speechId: 'sentence-1', sequence: 0, sampleRate: 24_000, pcmBase64: 'AAAAAA==',
    }

    expect(runtimeEventRecipients(audio, clients, interactive, native)).toEqual([dock])
    expect(runtimeEventRecipients({ event: 'audio-done', speechId: 'sentence-1', cancelled: false }, clients, interactive, native)).toEqual([dock])
    expect(runtimeEventRecipients({ event: 'state', phase: 'speaking', active: true, muted: false }, clients, interactive, native)).toEqual([...clients])
  })

  it('falls back to browser clients when the native playback observer is absent', () => {
    const activeBrowser = { id: 'browser-active' }
    const backgroundBrowser = { id: 'browser-background' }
    const interactive = new Set([activeBrowser, backgroundBrowser])
    const audio: RuntimeEvent = {
      event: 'audio', speechId: 'sentence-1', sequence: 0, sampleRate: 24_000, pcmBase64: 'AAAAAA==',
    }

    expect(runtimeEventRecipients(audio, interactive, interactive, new Set())).toEqual([...interactive])
  })

  it('drops only response speech that has not started during an early summary handoff', () => {
    const runtime = new KokoroVoiceRuntime({})
    const writeTts = vi.fn()
    const internals = runtime as unknown as {
      currentSpeech?: { speechId: string; text: string; kind: 'response'; startedAt?: number; audioDurationMs: number }
      speechQueue: Array<{ speechId: string; text: string; kind: 'response'; audioDurationMs: number }>
      writeTts(message: unknown): void
      dropUnstartedResponseSpeech(): void
    }
    internals.writeTts = writeTts
    internals.currentSpeech = { speechId: 'first', text: 'First.', kind: 'response', startedAt: Date.now(), audioDurationMs: 1_000 }
    internals.speechQueue.push({ speechId: 'second', text: 'Second.', kind: 'response', audioDurationMs: 0 })

    internals.dropUnstartedResponseSpeech()
    expect(internals.currentSpeech?.speechId).toBe('first')
    expect(internals.speechQueue).toEqual([])
    expect(writeTts).not.toHaveBeenCalled()

    internals.currentSpeech = { speechId: 'second-synthesizing', text: 'Second.', kind: 'response', audioDurationMs: 0 }
    internals.dropUnstartedResponseSpeech()
    expect(internals.currentSpeech).toBeUndefined()
    expect(writeTts).toHaveBeenCalledWith({ command: 'cancel', speechId: 'second-synthesizing' })
  })

  it('suppresses a pending holding phrase when genuine response audio starts first', () => {
    const cancel = vi.fn()
    const runtime = new KokoroVoiceRuntime({}, console, undefined, undefined, undefined, { start: vi.fn(), cancel })
    const timer = setTimeout(() => undefined, 10_000)
    const internals = runtime as unknown as {
      currentSpeech: { speechId: string; text: string; kind: 'response'; clientTag: string; audioDurationMs: number; startedAt?: number }
      holdingCandidate?: { requestId: string; result: { text: string; source: 'local-mlx' }; timer: NodeJS.Timeout }
      handleTtsLine(line: string): void
    }
    internals.currentSpeech = { speechId: 'response-1', text: 'Real response.', kind: 'response', clientTag: 'opening-1', audioDurationMs: 0 }
    internals.holdingCandidate = {
      requestId: 'holding-1',
      result: { text: 'Let me check that carefully.', source: 'local-mlx' },
      timer,
    }

    internals.handleTtsLine(JSON.stringify({
      event: 'audio', speechId: 'response-1', sequence: 0, sampleRate: 4, pcmBase64: 'AAAAAAAAAAAAAAAAAAAAAA==',
    }))

    expect(cancel).toHaveBeenCalledOnce()
    expect(internals.holdingCandidate).toBeUndefined()
    clearTimeout(timer)
  })

  it('accepts one server-validated holding candidate exactly once', () => {
    const runtime = new KokoroVoiceRuntime({})
    const enqueue = vi.fn()
    const internals = runtime as unknown as {
      holdingCandidate?: { requestId: string; result: { text: string; source: 'local-mlx' }; timer: NodeJS.Timeout }
      enqueueHoldingPhrase(requestId: string, text: string): void
      acceptHoldingPhrase(requestId: string): boolean
    }
    internals.enqueueHoldingPhrase = enqueue
    internals.holdingCandidate = {
      requestId: 'holding-1',
      result: { text: 'Let me check that carefully.', source: 'local-mlx' },
      timer: setTimeout(() => undefined, 10_000),
    }

    expect(internals.acceptHoldingPhrase('holding-1')).toBe(true)
    expect(internals.acceptHoldingPhrase('holding-1')).toBe(false)
    expect(enqueue).toHaveBeenCalledOnce()
    expect(enqueue).toHaveBeenCalledWith('holding-1', 'Let me check that carefully.')
  })

  it('uses only DSH-owned runtime defaults', async () => {
    vi.stubEnv('DSH_LIVE_VOICE_LOCALE', 'en-US')
    const root = path.join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness', 'live-voice-kokoro')
    const config = await resolveVoiceConfig({})

    expect(config).toMatchObject({
      runtimeRoot: path.join(root, 'kokoro'),
      pythonPath: path.join(root, 'kokoro', '.venv', 'bin', 'python'),
      modelPath: path.join(root, 'kokoro', 'model'),
      helperPath: path.join(root, 'bin', 'dsh-live-voice-input-helper'),
      locale: 'en-US',
      voice: 'af_heart',
      endTurnMs: 1500,
      speechRate: 1,
      acknowledgementDelayMs: 250,
      sidecarPath: path.join(ROOT, 'resources', 'kokoro-tts-sidecar.py'),
    })
    const { sidecarPath: _installedPluginResource, ...runtimePaths } = config
    expect(JSON.stringify(runtimePaths)).not.toMatch(/Pi Agent|Pi-Agent|\.worktrees/u)
  })

  it('resolves Pocket TTS from a DSH-owned runtime root when selected', async () => {
    const root = path.join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness', 'live-voice-kokoro')
    const config = await resolveVoiceConfig({ ttsBackend: 'pocket' })

    expect(config).toMatchObject({
      ttsBackend: 'pocket',
      runtimeRoot: path.join(root, 'pocket-tts'),
      pythonPath: path.join(root, 'pocket-tts', '.venv', 'bin', 'python'),
      modelPath: path.join(root, 'pocket-tts'),
      voice: 'alba',
      sidecarPath: path.join(ROOT, 'resources', 'pocket-tts-sidecar.py'),
    })
    expect(JSON.stringify(config)).not.toMatch(/Pi Agent|Pi-Agent|\.worktrees/u)
  })

  it.each([
    { backend: 'kokoro' as const, voice: 'af_heart' },
    { backend: 'pocket' as const, voice: 'alba' },
  ])('switches between Kokoro and Pocket ($backend/$voice) without host restart', async ({ backend, voice }) => {
    const runtime = new KokoroVoiceRuntime({})
    await runtime.initialize()
    await runtime.setTtsBackend(backend)
    expect((runtime as unknown as { config: { ttsBackend: string; voice: string } }).config).toMatchObject({ ttsBackend: backend, voice })
  })

  it('retains the selected engine when patching only timing', async () => {
    const runtime = new KokoroVoiceRuntime({})
    await runtime.initialize()
    await runtime.setTtsBackend('pocket')
    await runtime.updateSettings({ endTurnMs: 1_700 })
    expect((runtime as unknown as { config: { ttsBackend: string; voice: string; endTurnMs: number } }).config).toMatchObject({ ttsBackend: 'pocket', voice: 'alba', endTurnMs: 1_700 })
    await runtime.updateSettings({ speechRate: 0.85 })
    expect((runtime as unknown as { config: { ttsBackend: string } }).config.ttsBackend).toBe('pocket')
  })

  it('keeps explicit Harness overrides inside supported boundaries', async () => {
    const config = await resolveVoiceConfig({
      runtimeRoot: FIXTURE_RUNTIME,
      pythonPath: '/custom/python',
      modelPath: '/custom/model',
      helperPath: '/custom/helper',
      locale: 'en-US',
      voice: 'am_michael',
      endTurnMs: 900,
      speechRate: 0.8,
      acknowledgementDelayMs: 1000,
    })

    expect(config).toMatchObject({
      runtimeRoot: FIXTURE_RUNTIME,
      pythonPath: '/custom/python',
      modelPath: '/custom/model',
      helperPath: '/custom/helper',
      locale: 'en-US',
      voice: 'am_michael',
      endTurnMs: 900,
      speechRate: 0.8,
      acknowledgementDelayMs: 1000,
    })
  })

  it('ships a syntactically valid single-worker sidecar', () => {
    const sidecar = path.join(ROOT, 'resources', 'kokoro-tts-sidecar.py')
    const source = readFileSync(sidecar, 'utf8')
    execFileSync('python3', ['-c', 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], "exec")', sidecar])
    expect(source).toContain('queue.Queue')
    expect(source).toContain('daemon=True')
    expect(source).not.toContain('threading.Thread(target=speak')
  })

  it('ships a syntactically valid Pocket TTS streaming sidecar', () => {
    const sidecar = path.join(ROOT, 'resources', 'pocket-tts-sidecar.py')
    const source = readFileSync(sidecar, 'utf8')
    execFileSync('python3', ['-c', 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], "exec")', sidecar])
    expect(source).toContain('generate_audio_stream')
    expect(source).toContain('DSH_POCKET_TTS_ROOT')
    expect(source).toContain('sampleRate')
  })

  it('settles a cancelled queued utterance without entering model inference', async () => {
    const sidecar = path.join(ROOT, 'resources', 'kokoro-tts-sidecar.py')
    const fakeKokoro = path.join(import.meta.dirname, 'fixtures', 'fake-kokoro')
    const child = spawn('python3', [sidecar], {
      env: scrubbedSidecarEnv({ PI_GUI_VOICE_MODEL: 'fake-model', PYTHONPATH: fakeKokoro }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    const messages: Array<Record<string, unknown>> = []
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', (line) => messages.push(JSON.parse(line) as Record<string, unknown>))
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`)

    try {
      send({ command: 'warm' })
      await waitForMessage(messages, (message) => message.event === 'ready')
      send({ command: 'speak', speechId: 'first', text: 'first' })
      send({ command: 'speak', speechId: 'cancelled', text: 'cancel before inference' })
      send({ command: 'cancel', speechId: 'cancelled' })
      await waitForMessage(messages, (message) => message.event === 'done' && message.speechId === 'cancelled')

      expect(messages).toContainEqual({ event: 'done', speechId: 'cancelled', cancelled: true })
      expect(messages.some((message) => message.event === 'error')).toBe(false)
    } finally {
      if (child.exitCode === null) send({ command: 'shutdown' })
      await exited
      lines.close()
    }
  })
})

describe('playback microphone gate', () => {
  function gatedRuntime(): {
    readonly runtime: KokoroVoiceRuntime
    readonly internals: {
      activeSessionId?: string
      inputLease?: { clientId: string; leaseId: string; sessionId: string }
      currentSpeech?: { speechId: string; text: string; kind: 'response'; startedAt?: number; audioDurationMs: number }
      micGateUntil: number
      cancelSpeech(): void
      emit(event: RuntimeEvent): void
      setPhase(phase: string): void
      handleInputLine(line: string): void
      handleTtsLine(line: string): void
    }
    readonly cancelSpeech: ReturnType<typeof vi.fn>
    readonly emit: ReturnType<typeof vi.fn>
  } {
    const runtime = new KokoroVoiceRuntime({})
    const cancelSpeech = vi.fn()
    const emit = vi.fn()
    const internals = runtime as unknown as {
      activeSessionId?: string
      inputLease?: { clientId: string; leaseId: string; sessionId: string }
      currentSpeech?: { speechId: string; text: string; kind: 'response'; startedAt?: number; audioDurationMs: number }
      micGateUntil: number
      cancelSpeech(): void
      emit(event: RuntimeEvent): void
      setPhase(phase: string): void
      handleInputLine(line: string): void
      handleTtsLine(line: string): void
    }
    internals.activeSessionId = 'session-gate'
    internals.inputLease = { clientId: 'client-gate', leaseId: 'lease-gate', sessionId: 'session-gate' }
    internals.currentSpeech = {
      speechId: 'speech-gate',
      text: 'The deployment is ready now, and the next validation can begin.',
      kind: 'response',
      audioDurationMs: 0,
    }
    internals.cancelSpeech = cancelSpeech
    internals.emit = emit
    internals.setPhase = vi.fn()
    internals.handleInputLine(JSON.stringify({ event: 'speechStarted' }))
    return { runtime, internals, cancelSpeech, emit }
  }

  const audioChunk = JSON.stringify({
    event: 'audio', speechId: 'speech-gate', sequence: 0, sampleRate: 4, pcmBase64: 'AAAAAAAAAAAAAAAAAAAAAA==',
  })

  it('drops paraphrased loopback while TTS audio is flowing but lets an explicit stop through', () => {
    const { internals, cancelSpeech, emit } = gatedRuntime()
    internals.handleTtsLine(audioChunk)
    emit.mockClear()

    internals.handleInputLine(JSON.stringify({ event: 'partial', text: 'deployment is ready now and validation can begin' }))
    expect(cancelSpeech).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()

    internals.handleInputLine(JSON.stringify({ event: 'partial', text: 'Stop that and use the backup instead' }))
    expect(cancelSpeech).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'partial' }))
  })

  it('holds echo-suspect loopback through the post-playback tail but lets unrelated speech barge in', () => {
    const { internals, cancelSpeech, emit } = gatedRuntime()
    internals.handleTtsLine(audioChunk)
    internals.handleTtsLine(JSON.stringify({ event: 'done', speechId: 'speech-gate' }))
    emit.mockClear()

    // Echo paraphrase of the just-played turn is still loopback in the tail.
    internals.handleInputLine(JSON.stringify({ event: 'partial', text: 'deployment is ready now and validation can begin' }))
    expect(cancelSpeech).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()

    // Unrelated speech is a genuine barge-in and must not be suppressed.
    internals.handleInputLine(JSON.stringify({ event: 'partial', text: 'Actually use the backup instead' }))
    expect(cancelSpeech).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'partial', text: 'Actually use the backup instead' }))
  })

  it('keeps the gate shut until the estimated audible end, not just the fixed tail', () => {
    const { internals } = gatedRuntime()
    if (internals.currentSpeech) {
      internals.currentSpeech.startedAt = Date.now()
      internals.currentSpeech.audioDurationMs = 20_000
    }
    internals.handleTtsLine(JSON.stringify({ event: 'done', speechId: 'speech-gate' }))
    // A bare now + 600 ms tail would reopen the mic while ~20 s of queued
    // client audio is still audible; the anchored gate must cover the turn.
    expect(internals.micGateUntil - Date.now()).toBeGreaterThan(5_000)
  })

  it('lets unrelated words through the gate while holding echo-suspect finals', () => {
    const { internals, cancelSpeech, emit } = gatedRuntime()
    internals.handleTtsLine(audioChunk)
    emit.mockClear()

    // Unrelated single word: a real utterance, not playback — must pass.
    internals.handleInputLine(JSON.stringify({ event: 'final', text: 'banana' }))
    expect(cancelSpeech).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: 'final', text: 'banana' }))

    cancelSpeech.mockClear()
    emit.mockClear()
    internals.handleInputLine(JSON.stringify({ event: 'speechStarted' }))

    // Lone playback tail word stays echo and must not submit a new turn.
    internals.handleInputLine(JSON.stringify({ event: 'final', text: 'ready' }))
    expect(cancelSpeech).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('treats a lone playback word as echo while keeping barge-in words live', () => {
    expect(isLikelyPlaybackEcho('ready', ['The deployment is ready now, and the next validation can begin.'])).toBe(true)
    expect(isLikelyPlaybackEcho('banana', ['The deployment is ready now, and the next validation can begin.'])).toBe(false)
    expect(isLikelyPlaybackEcho('Stop the playback now', ['Stop the playback now, it is finished.'])).toBe(false)
  })
})

function scrubbedSidecarEnv(extra: Record<string, string>): Record<string, string> {
  // Scrub ambient DSH_/BRIDGE_ before spawning the sidecar: an inherited
  // operator-shell DSH_HOME/BRIDGE_TOKEN must never redirect the fake
  // sidecar run. Explicit per-test values in `extra` win.
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (!Object.prototype.hasOwnProperty.call(extra, key) && (/^DSH_/u.test(key) || /^BRIDGE_/u.test(key))) delete env[key]
  }
  return { ...env, ...extra } as Record<string, string>
}

async function waitForMessage(
  messages: Array<Record<string, unknown>>,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!messages.some(predicate)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for sidecar message. Received: ${JSON.stringify(messages)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
