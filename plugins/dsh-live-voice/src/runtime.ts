import { randomUUID } from 'node:crypto'
import { readHttpJsonObject } from './http-json.ts'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { HoldingActivity, HoldingPhraseRequest, HoldingPhraseResult } from './holding-phrase-provider.ts'
import { saveVoiceSettings, sanitizeSettings, settingsFromConfig, type VoiceSettingsPatch } from './voice-settings.ts'
import { validateHoldingPhrase } from './shared/holding-phrase.ts'
import { DEFAULT_VOICE_DEFAULTS, defaultKokoroRoot, defaultLiveVoiceRoot, defaultPocketRoot, defaultSpeechLocale } from './voice-defaults.ts'

export const EVENTS_PATH = '/dsh-kokoro-live-voice/events'
export const COMMAND_PATH = '/dsh-kokoro-live-voice/command'
export const STATUS_PATH = '/dsh-kokoro-live-voice/status'
export const SETTINGS_PATH = '/dsh-kokoro-live-voice/settings'

const MAX_SPEECH_CHARS = 4_000
const MAX_SUMMARY_SOURCE_CHARS = 32_000
const MAX_SUMMARY_CONTEXT_CHARS = 4_000
const MAX_SUMMARY_OUTPUT_CHARS = 3_000
const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024
const KOKORO_SHUTDOWN_DELAY_MS = 120_000
// Microphone gate while locally played TTS is audible. The input helper no
// longer enables hardware echo cancellation (Pi's setVoiceProcessingEnabled
// path faulted the VoiceProcessor on some macOS routes and stopped capture),
// so speaker output reaches the microphone. The gate stays shut until the
// estimated audible playout end (first-chunk start + synthesized audio length
// + chain margin), plus a short tail for room decay and recognizer lag — a
// bare `now + N ms` per chunk would reopen the mic while queued client audio
// is still playing. Inside the window only echo-suspect transcripts are
// treated as loopback; unrelated speech still barges in, and explicit
// command words ("stop", "wait", ...) always break through. Text-similarity
// echo filtering remains as the second layer outside the window.
const PLAYBACK_GATE_ACTIVE_MS = 1_200
const PLAYBACK_GATE_TAIL_MS = 600
// Browser PCM is chained behind SSE delivery and the client's playout cursor;
// keep the phase tail margin above one chunk interval so the microphone does
// not reopen while the last sentence is still audible.
const PLAYBACK_TAIL_MARGIN_MS = 150

export interface VoicePluginConfig {
  watchConsentPath?: string
  runtimeRoot?: string
  pythonPath?: string
  modelPath?: string
  helperPath?: string
  sidecarPath?: string
  ttsBackend?: string
  pocketRuntimeRoot?: string
  pocketPythonPath?: string
  pocketSidecarPath?: string
  pocketVoice?: string
  locale?: string
  voice?: string
  endTurnMs?: number
  speechRate?: number
  acknowledgementDelayMs?: number
  holdingPhraseProvider?: string
  holdingPhraseDelayMs?: number
  holdingPhraseDiagnostics?: boolean
  summaryBackend?: string
  summaryRuntimeRoot?: string
  summaryPythonPath?: string
  summaryModelPath?: string
  summarySidecarPath?: string
  summaryIdleMs?: number
  summaryProvider?: string
  summaryModel?: string
}

export type TtsBackend = 'kokoro' | 'pocket'

export interface ResolvedVoiceConfig {
  ttsBackend: TtsBackend
  runtimeRoot: string
  pythonPath: string
  modelPath: string
  helperPath: string
  sidecarPath: string
  locale: string
  voice: string
  pocketVoice: string
  endTurnMs: number
  speechRate: number
  acknowledgementDelayMs: number
  holdingPhraseDelayMs: number
}

type RuntimePhase = 'idle' | 'starting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'muted' | 'error'
type SpeechKind = 'response' | 'local' | 'system'
type JsonRecord = Record<string, unknown>

export interface HoldingPhraseController {
  start(request: HoldingPhraseRequest, play: (result: HoldingPhraseResult) => void): void
  cancel(): void
  setDelay?(delayMs: number): void
}

interface QueuedSpeech {
  readonly speechId: string
  readonly text: string
  readonly kind: SpeechKind
  readonly clientTag?: string
  startedAt?: number
  audioDurationMs: number
}

export interface InputLease {
  readonly clientId: string
  readonly leaseId: string
  readonly sessionId: string
}

export interface VoiceSummaryRequest {
  readonly summaryId: string
  readonly responseText: string
  readonly spokenLead: string
  readonly userText: string
}

export type VoiceSummaryGenerator = (
  request: VoiceSummaryRequest,
  onDelta: (text: string) => void,
  signal: AbortSignal,
) => Promise<boolean>

export type RuntimeEvent =
  | { event: 'state'; phase: RuntimePhase; active: boolean; muted: boolean; sessionId?: string; message?: string }
  | ({ event: 'partial'; text: string; utteranceId: string } & InputLease)
  | ({ event: 'final'; text: string; utteranceId: string } & InputLease)
  | ({ event: 'dictate-partial'; text: string; utteranceId: string } & InputLease)
  | ({ event: 'dictate-final'; text: string; utteranceId: string } & InputLease)
  | ({ event: 'dictate-error'; message: string } & InputLease)
  | { event: 'ownership-revoked'; leaseId: string }
  | { event: 'audio'; speechId: string; sequence: number; sampleRate: number; pcmBase64: string }
  | { event: 'speech-started'; speechId: string; clientTag?: string }
  | { event: 'audio-done'; speechId: string; cancelled: boolean }
  | { event: 'audio-cancel'; speechId?: string }
  | { event: 'summary-delta'; summaryId: string; text: string }
  | { event: 'summary-done'; summaryId: string; ok: boolean }
  | { event: 'holding-ready'; requestId: string; text: string; source: HoldingPhraseResult['source'] }
  | { event: 'config'; ttsBackend: TtsBackend; locale: string; voice: string; speechRate: number; acknowledgementDelayMs: number }

export class KokoroVoiceRuntime {
  private config: ResolvedVoiceConfig | undefined
  private inputProcess: ChildProcessWithoutNullStreams | undefined
  private ttsProcess: ChildProcessWithoutNullStreams | undefined
  private ttsReady: Promise<void> | undefined
  private resolveTtsReady: (() => void) | undefined
  private rejectTtsReady: ((error: Error) => void) | undefined
  private readonly clients = new Set<ServerResponse>()
  private readonly interactiveClients = new Set<ServerResponse>()
  private readonly nativeClients = new Set<ServerResponse>()
  private readonly clientIds = new Map<ServerResponse, string>()
  private readonly clientsById = new Map<string, ServerResponse>()
  private inputLease: InputLease | undefined
  private readonly utterances = new InputUtteranceGate()
  private ownerDisconnectTimer: NodeJS.Timeout | undefined
  // STT-only dictation (Mac built-in Apple Speech): shares the single input
  // helper with Live Voice under mutual exclusion — finals go to the composer
  // draft instead of auto-prompting. Live Voice behaviour is unchanged.
  private dictateLease: InputLease | undefined
  private readonly dictateUtterances = new InputUtteranceGate()
  private dictateDisconnectTimer: NodeJS.Timeout | undefined
  private activeSessionId: string | undefined
  private phase: RuntimePhase = 'idle'
  private muted = false
  private currentSpeech: QueuedSpeech | undefined
  private readonly speechQueue: QueuedSpeech[] = []
  private readonly recentSpeechEchoes: Array<{ readonly text: string; readonly expiresAt: number }> = []
  private micGateUntil = 0
  private shutdownTimer: NodeJS.Timeout | undefined
  private playbackTimer: NodeJS.Timeout | undefined
  private summaryTask: { readonly id: string; readonly controller: AbortController } | undefined
  private holdingCandidate: { readonly requestId: string; readonly result: HoldingPhraseResult; readonly timer: NodeJS.Timeout } | undefined
  private disposed = false

  constructor(
    private readonly rawConfig: VoicePluginConfig,
    private readonly log: Pick<Console, 'warn' | 'error'> = console,
    private readonly generateSummary?: VoiceSummaryGenerator,
    private readonly warmSummary?: () => Promise<void>,
    private readonly releaseSummary?: () => void,
    private readonly holdingPhrases?: HoldingPhraseController,
  ) {}

  async initialize(): Promise<void> {
    this.config = await resolveVoiceConfig(this.rawConfig)
  }

  status(): RuntimeEvent {
    return {
      event: 'state',
      phase: this.phase,
      active: this.activeSessionId !== undefined,
      muted: this.muted,
      ...(this.activeSessionId ? { sessionId: this.activeSessionId } : {}),
    }
  }

  settings(): VoiceSettingsPatch {
    return settingsFromConfig(this.requireConfig())
  }

  /** Watch-service exclusion view (Role V §9): read-only, never steals leases. */
  get watchExclusion(): {
    readonly activeSessionId: string | undefined
    readonly dictateLease: InputLease | undefined
  } {
    return { activeSessionId: this.activeSessionId, dictateLease: this.dictateLease }
  }

  attachEvents(req: IncomingMessage, res: ServerResponse): void {
    if (!isLoopback(req)) return json(res, 403, { error: 'Live Voice is available only from this Mac.' })
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    })
    res.write(': connected\n\n')
    this.clients.add(res)
    const parameters = new URL(req.url ?? EVENTS_PATH, 'http://127.0.0.1').searchParams
    const observer = parameters.get('observer') === 'native'
    const nativePlayback = observer || parameters.get('playback') === 'native'
    const clientId = boundedPlainString(parameters.get('clientId'), 200)
    if (clientId && !observer) {
      const previous = this.clientsById.get(clientId)
      if (previous && previous !== res) {
        this.removeClient(previous)
        previous.end()
      }
      this.clientIds.set(res, clientId)
      this.clientsById.set(clientId, res)
      if (this.inputLease?.clientId === clientId) this.clearOwnerDisconnectTimer()
      if (this.dictateLease?.clientId === clientId) this.clearDictateDisconnectTimer()
    }
    if (nativePlayback) this.nativeClients.add(res)
    if (!observer) this.interactiveClients.add(res)
    this.emitTo(res, this.status())
    const config = this.requireConfig()
    this.emitTo(res, {
      event: 'config',
      ttsBackend: config.ttsBackend,
      locale: config.locale,
      voice: config.voice,
      speechRate: config.speechRate,
      acknowledgementDelayMs: config.acknowledgementDelayMs,
    })
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': keepalive\n\n')
    }, 15_000)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      const disconnectedOwner = this.inputLease?.clientId === this.clientIds.get(res)
      const disconnectedDictator = this.dictateLease?.clientId === this.clientIds.get(res)
      this.removeClient(res)
      if (disconnectedOwner && this.inputLease) this.scheduleOwnerDisconnect(this.inputLease)
      if (disconnectedDictator && this.dictateLease) this.scheduleDictateDisconnect(this.dictateLease)
    }
    req.once('close', close)
    res.once('close', close)
  }

  async handleSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopback(req)) return json(res, 403, { error: 'Live Voice is available only from this Mac.' })
    if (req.method === 'GET') return json(res, 200, this.settings())
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    if (!/^application\/json(?:\s*;|$)/iu.test(String(req.headers['content-type'] ?? ''))) {
      return json(res, 415, { error: 'content type must be application/json' })
    }
    try {
      const body = await readJsonBody(req)
      if (this.activeSessionId) return json(res, 409, { error: 'End Live Voice before changing settings.' })
      const patch = sanitizeSettings(body.patch ?? body)
      if (Object.keys(patch).length === 0) return json(res, 400, { error: 'No supported Live Voice settings were supplied.' })
      await this.updateSettings(patch)
      return json(res, 200, this.settings())
    } catch (error) {
      return json(res, error instanceof RangeError ? 413 : 400, { error: safeMessage(error) })
    }
  }

  async handleCommand(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopback(req)) return json(res, 403, { error: 'Live Voice is available only from this Mac.' })
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
    if (!/^application\/json(?:\s*;|$)/iu.test(String(req.headers['content-type'] ?? ''))) {
      return json(res, 415, { error: 'content type must be application/json' })
    }
    let body: JsonRecord
    try {
      body = await readJsonBody(req)
    } catch (error) {
      return json(res, error instanceof RangeError ? 413 : 400, { error: safeMessage(error) })
    }
    try {
      switch (body.command) {
        case 'set-tts-backend': {
          if (this.activeSessionId) return json(res, 409, { error: 'End Live Voice before changing the speech engine.' })
          await this.setTtsBackend(resolveTtsBackend(body.ttsBackend))
          return json(res, 200, { ok: true })
        }
        case 'start': {
          const sessionId = validSessionId(body.sessionId)
          const clientId = boundedPlainString(body.clientId, 200)
          const leaseId = boundedPlainString(body.leaseId, 200)
          if (!sessionId || !clientId || !leaseId) return json(res, 400, { error: 'invalid input lease' })
          if (this.dictateLease) return json(res, 409, { error: 'Stop dictation before starting Live Voice.' })
          if (!this.clientsById.has(clientId)) await this.waitForClient(clientId)
          if (!this.clientsById.has(clientId)) {
            return json(res, 409, { error: 'input owner is not connected' })
          }
          await this.start({ sessionId, clientId, leaseId })
          return json(res, 200, { ok: true })
        }
        case 'dictate-start': {
          const sessionId = validSessionId(body.sessionId)
          const clientId = boundedPlainString(body.clientId, 200)
          const leaseId = boundedPlainString(body.leaseId, 200)
          if (!sessionId || !clientId || !leaseId) return json(res, 400, { error: 'invalid input lease' })
          if (this.activeSessionId) return json(res, 409, { error: 'End Live Voice before dictating.' })
          if (!this.clientsById.has(clientId)) await this.waitForClient(clientId)
          if (!this.clientsById.has(clientId)) {
            return json(res, 409, { error: 'input owner is not connected' })
          }
          await this.dictateStart({ sessionId, clientId, leaseId })
          return json(res, 200, { ok: true })
        }
        case 'dictate-stop':
          if (!this.ownsDictateLease(body)) return json(res, 409, { error: 'dictation lease is no longer active' })
          await this.dictateStop()
          return json(res, 200, { ok: true })
        case 'stop':
          if (!this.ownsLease(body)) return json(res, 409, { error: 'input lease is no longer active' })
          await this.stop()
          return json(res, 200, { ok: true })
        case 'mute':
          if (!this.ownsLease(body)) return json(res, 409, { error: 'input lease is no longer active' })
          this.setMuted(body.muted === true)
          return json(res, 200, { ok: true })
        case 'cancel':
          if (!this.ownsLease(body)) return json(res, 409, { error: 'input lease is no longer active' })
          this.cancelSpeech()
          return json(res, 200, { ok: true })
        case 'thinking':
          if (!this.ownsLease(body)) return json(res, 409, { error: 'input lease is no longer active' })
          if (this.activeSessionId) this.setPhase('thinking')
          return json(res, 200, { ok: true })
        case 'holding': {
          if (!this.ownsLease(body)) return json(res, 409, { error: 'input lease is no longer active' })
          if (!this.activeSessionId) return json(res, 409, { error: 'Live Voice is not active.' })
          const request = validHoldingPhraseRequest(body)
          if (!request || !this.holdingPhrases) return json(res, 400, { error: 'invalid holding phrase request' })
          this.holdingPhrases.start(request, (result) => {
            if (this.activeSessionId) this.offerHoldingPhrase(request.requestId, result)
          })
          return json(res, 202, { ok: true })
        }
        case 'accept-holding': {
          if (!this.ownsLease(body)) return json(res, 409, { error: 'input lease is no longer active' })
          const requestId = boundedPlainString(body.requestId, 200)
          if (!requestId || !this.acceptHoldingPhrase(requestId)) return json(res, 409, { error: 'holding phrase is no longer active' })
          return json(res, 200, { ok: true })
        }
        case 'summarize': {
          if (!this.ownsLease(body)) return json(res, 409, { error: 'input lease is no longer active' })
          if (!this.activeSessionId) return json(res, 409, { error: 'Live Voice is not active.' })
          const request = validSummaryRequest(body)
          if (!request) return json(res, 400, { error: 'invalid summary request' })
          if (!this.generateSummary) return json(res, 503, { error: 'voice summary generation is unavailable' })
          this.startSummary(request)
          return json(res, 202, { ok: true })
        }
        case 'speak': {
          if (!this.ownsLease(body)) return json(res, 409, { error: 'input lease is no longer active' })
          const text = typeof body.text === 'string' ? body.text.trim() : ''
          const kind = isSpeechKind(body.kind) ? body.kind : 'response'
          const clientTag = boundedPlainString(body.clientTag, 200)
          if (!text || text.length > MAX_SPEECH_CHARS) return json(res, 400, { error: 'invalid speech text' })
          this.enqueueSpeech(text, kind, body.replace === true, body.summaryHandoff === true, clientTag)
          return json(res, 200, { ok: true })
        }
        default:
          return json(res, 400, { error: 'unknown command' })
      }
    } catch (error) {
      this.setPhase('error', safeMessage(error))
      return json(res, 500, { error: safeMessage(error) })
    }
  }

  async start(lease: InputLease): Promise<void> {
    if (this.disposed) throw new Error('Kokoro Live Voice has shut down.')
    // The single input helper is shared under mutual exclusion: the command
    // layer refuses this with a 409, and the direct call fails here so a
    // dictation lease can never be silently orphaned by a Live Voice start.
    if (this.dictateLease) throw new Error('Stop dictation before starting Live Voice.')
    this.clearOwnerDisconnectTimer()
    this.clearShutdownTimer()
    if (sameInputLease(this.inputLease, lease) && this.activeSessionId === lease.sessionId) return
    const previousLease = this.inputLease
    if (previousLease) {
      const previousClient = this.clientsById.get(previousLease.clientId)
      if (previousClient) this.emitTo(previousClient, { event: 'ownership-revoked', leaseId: previousLease.leaseId })
      this.writeInput({ command: 'stop' })
    }
    this.inputLease = lease
    this.utterances.reset()
    this.activeSessionId = lease.sessionId
    this.muted = false
    this.micGateUntil = 0
    this.cancelSpeech()
    this.recentSpeechEchoes.length = 0
    this.setPhase('starting')
    const config = this.requireConfig()
    // Summary warming is deliberately non-blocking: microphone and Kokoro
    // startup stay responsive while the private local model loads in parallel.
    void this.warmSummary?.().catch((error: unknown) => {
      this.log.warn(`[kokoro-live-voice:summary] Warmup failed: ${safeMessage(error)}`)
    })
    await Promise.all([this.ensureInputProcess(), this.ensureTtsReady()])
    if (!sameInputLease(this.inputLease, lease)) return
    this.writeInput({
      command: 'start',
      mode: 'live',
      locale: config.locale,
      endTurnMs: config.endTurnMs,
    })
  }

  async stop(scheduleShutdown = true): Promise<void> {
    this.clearOwnerDisconnectTimer()
    this.cancelSpeech()
    this.micGateUntil = 0
    this.writeInput({ command: 'stop' })
    this.inputLease = undefined
    this.utterances.reset()
    this.activeSessionId = undefined
    this.muted = false
    this.recentSpeechEchoes.length = 0
    this.setPhase('idle')
    this.releaseSummary?.()
    if (scheduleShutdown) this.scheduleTtsShutdown()
  }

  /** STT-only dictation via the Mac built-in Apple Speech helper. Never prompts. */
  async dictateStart(lease: InputLease): Promise<void> {
    if (this.disposed) throw new Error('Kokoro Live Voice has shut down.')
    if (this.activeSessionId) throw new Error('End Live Voice before dictating.')
    this.clearDictateDisconnectTimer()
    if (sameInputLease(this.dictateLease, lease)) return
    const previousLease = this.dictateLease
    if (previousLease) {
      const previousClient = this.clientsById.get(previousLease.clientId)
      if (previousClient) this.emitTo(previousClient, { event: 'ownership-revoked', leaseId: previousLease.leaseId })
      this.writeInput({ command: 'stop' })
    }
    this.dictateLease = lease
    this.dictateUtterances.reset()
    await this.ensureInputProcess()
    if (!sameInputLease(this.dictateLease, lease)) return
    const config = this.requireConfig()
    this.writeInput({
      command: 'start',
      mode: 'dictation',
      locale: config.locale,
      endTurnMs: config.endTurnMs,
    })
  }

  async dictateStop(): Promise<void> {
    this.clearDictateDisconnectTimer()
    this.dictateUtterances.reset()
    this.dictateLease = undefined
    // Live Voice owns TTS shutdown; dictation only releases the microphone and
    // only when Live Voice is not using it.
    if (!this.activeSessionId) this.writeInput({ command: 'stop' })
  }

  private failDictation(message: string): void {
    const lease = this.dictateLease
    if (!lease) return
    this.dictateUtterances.reset()
    this.dictateLease = undefined
    this.emit({ event: 'dictate-error', message, ...lease })
  }

  async setTtsBackend(ttsBackend: TtsBackend): Promise<void> {
    await this.updateSettings({ ttsBackend })
  }

  async updateSettings(patch: VoiceSettingsPatch): Promise<void> {
    if (this.activeSessionId) throw new Error('End Live Voice before changing settings.')
    const current = this.requireConfig()
    const patchHasVoice = Object.prototype.hasOwnProperty.call(patch, 'voice') || Object.prototype.hasOwnProperty.call(patch, 'pocketVoice')
    const patchHasTiming = Object.prototype.hasOwnProperty.call(patch, 'endTurnMs')
      || Object.prototype.hasOwnProperty.call(patch, 'speechRate')
      || Object.prototype.hasOwnProperty.call(patch, 'acknowledgementDelayMs')
      || Object.prototype.hasOwnProperty.call(patch, 'holdingPhraseDelayMs')
      || Object.prototype.hasOwnProperty.call(patch, 'locale')
    // A timing/locale-only change must not clobber the live backend or carry
    // the display voice of the opposite engine (e.g. Kokoro→Pocket timing tweak
    // must stay on Pocket with its current voice).
    if (patchHasTiming && !patch.ttsBackend && !patchHasVoice) {
      const next = await resolveVoiceConfig({
        ...this.rawConfig,
        ...settingsFromConfig(current),
        ...patch,
      })
      this.config = next
      this.holdingPhrases?.setDelay?.(next.holdingPhraseDelayMs)
      await saveVoiceSettings(settingsFromConfig(next))
      this.emit({ event: 'config', ttsBackend: next.ttsBackend, locale: next.locale, voice: next.voice, speechRate: next.speechRate, acknowledgementDelayMs: next.acknowledgementDelayMs })
      return
    }
    const merged: VoiceSettingsPatch = { ...settingsFromConfig(current), ...patch }
    if (patch.ttsBackend || patch.voice || patch.pocketVoice) {
      if (patch.ttsBackend === 'kokoro' && !patch.voice) delete (merged as Record<string, unknown>).pocketVoice
      if (patch.ttsBackend === 'pocket' && !patch.pocketVoice) delete (merged as Record<string, unknown>).voice
    }
    const next = await resolveVoiceConfig({ ...this.rawConfig, ...merged })
    const backendChanged = current.ttsBackend !== next.ttsBackend
    if (backendChanged) {
      this.clearShutdownTimer()
      const child = this.ttsProcess
      this.ttsProcess = undefined
      this.ttsReady = undefined
      this.resolveTtsReady = undefined
      this.rejectTtsReady = undefined
      if (child?.stdin.writable) child.stdin.write(`${JSON.stringify({ command: 'shutdown' })}\n`)
      if (child?.exitCode === null) child.kill()
    }
    this.config = next
    this.holdingPhrases?.setDelay?.(next.holdingPhraseDelayMs)
    await saveVoiceSettings(settingsFromConfig(next))
    this.emit({
      event: 'config',
      ttsBackend: next.ttsBackend,
      locale: next.locale,
      voice: next.voice,
      speechRate: next.speechRate,
      acknowledgementDelayMs: next.acknowledgementDelayMs,
    })
  }

  setMuted(muted: boolean): void {
    if (!this.activeSessionId) return
    this.muted = muted
    this.writeInput({ command: 'mute', muted })
    this.setPhase(muted ? 'muted' : 'listening')
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.clearOwnerDisconnectTimer()
    this.clearDictateDisconnectTimer()
    this.dictateLease = undefined
    this.dictateUtterances.reset()
    this.clearShutdownTimer()
    this.clearPlaybackTimer()
    this.cancelSpeech()
    this.writeInput({ command: 'shutdown' })
    this.writeTts({ command: 'shutdown' })
    this.inputProcess?.kill()
    this.ttsProcess?.kill()
    this.inputProcess = undefined
    this.ttsProcess = undefined
    for (const client of this.clients) client.end()
    this.clients.clear()
    this.interactiveClients.clear()
    this.nativeClients.clear()
    this.clientIds.clear()
    this.clientsById.clear()
  }

  private async ensureInputProcess(): Promise<void> {
    if (this.inputProcess && !this.inputProcess.killed) return
    const config = this.requireConfig()
    await access(config.helperPath)
    const child = spawn(config.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.inputProcess = child
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') this.log.warn(`[kokoro-live-voice:input] ${error.message}`)
    })
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleInputLine(line))
    child.stderr.on('data', (chunk) => this.log.warn(`[kokoro-live-voice:input] ${String(chunk).trim()}`))
    child.once('error', (error) => {
      if (this.inputProcess !== child) return
      this.inputProcess = undefined
      if (this.activeSessionId) this.setPhase('error', `The local Apple Speech helper could not start: ${error.message}`)
      else this.failDictation(`The local Apple Speech helper could not start: ${error.message}`)
    })
    child.once('exit', () => {
      if (this.inputProcess !== child) return
      this.inputProcess = undefined
      if (this.activeSessionId) this.setPhase('error', 'The local Apple Speech helper stopped.')
      else this.failDictation('The local Apple Speech helper stopped.')
    })
  }

  private async ensureTtsReady(): Promise<void> {
    if (this.ttsProcess && !this.ttsProcess.killed && !this.ttsReady) return
    if (this.ttsReady) return this.ttsReady
    const config = this.requireConfig()
    await Promise.all([access(config.pythonPath), access(config.modelPath), access(config.sidecarPath)])
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    this.ttsReady = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    this.resolveTtsReady = resolveReady
    this.rejectTtsReady = rejectReady
    const child = spawn(config.pythonPath, [config.sidecarPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: config.ttsBackend === 'pocket'
        ? {
            ...process.env,
            DSH_POCKET_TTS_ROOT: config.runtimeRoot,
            DSH_POCKET_TTS_VOICE: config.voice,
            HF_HOME: path.join(config.runtimeRoot, 'hf-home'),
            HUGGINGFACE_HUB_CACHE: path.join(config.runtimeRoot, 'hf-home', 'hub'),
          }
        : { ...process.env, PI_GUI_VOICE_MODEL: config.modelPath },
    })
    this.ttsProcess = child
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') this.log.warn(`[kokoro-live-voice:tts] ${error.message}`)
    })
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleTtsLine(line))
    child.stderr.on('data', (chunk) => this.log.warn(`[kokoro-live-voice:tts] ${String(chunk).trim()}`))
    child.once('error', (error) => {
      if (this.ttsProcess !== child) return
      this.rejectTtsReady?.(error)
      this.ttsProcess = undefined
      this.resolveTtsReady = undefined
      this.rejectTtsReady = undefined
      this.ttsReady = undefined
      if (this.activeSessionId) this.setPhase('error', `The local Kokoro process could not start: ${error.message}`)
    })
    child.once('exit', () => {
      if (this.ttsProcess !== child) return
      this.ttsProcess = undefined
      const error = new Error('The local Kokoro process stopped.')
      this.rejectTtsReady?.(error)
      this.resolveTtsReady = undefined
      this.rejectTtsReady = undefined
      this.ttsReady = undefined
      this.currentSpeech = undefined
      this.speechQueue.length = 0
      if (this.activeSessionId) this.setPhase('error', error.message)
    })
    this.writeTts({ command: 'warm' })
    try {
      await withTimeout(this.ttsReady, 120_000, 'The local Kokoro model did not become ready.')
    } catch (error) {
      if (this.ttsProcess === child) {
        this.ttsProcess = undefined
        child.kill()
      }
      this.resolveTtsReady = undefined
      this.rejectTtsReady = undefined
      this.ttsReady = undefined
      throw error
    }
  }

  private handleInputLine(line: string): void {
    const message = parseJsonLine(line)
    if (!message) return
    // Dictation owns the helper while Live Voice is idle: forward Apple Speech
    // transcripts to the dictation owner only, without touching Live Voice
    // phase, TTS, or prompts.
    if (!this.activeSessionId) {
      this.handleDictateInputLine(message)
      return
    }
    switch (message.event) {
      case 'ready':
      case 'unmuted':
        if (!this.muted) this.setPhase('listening')
        break
      case 'speechStarted':
        this.utterances.start()
        break
      case 'muted':
        this.muted = true
        this.setPhase('muted')
        break
      case 'partial':
        if (this.muted) break
        if (typeof message.text === 'string' && meaningfulTranscript(message.text)) {
          const text = message.text.trim()
          if (this.isPlaybackEcho(text) || this.isGatedLoopback(text) || shouldDeferShortPartial(text)) break
          const lease = this.inputLease
          if (!lease) break
          const utteranceId = this.utterances.current()
          this.cancelSpeech()
          this.setPhase('hearing')
          this.emit({ event: 'partial', text, utteranceId, ...lease })
        }
        break
      case 'final':
        if (this.muted) break
        if (typeof message.text === 'string' && meaningfulTranscript(message.text)) {
          const text = message.text.trim()
          const utteranceId = this.utterances.finalize()
          if (this.isPlaybackEcho(text) || this.isGatedLoopback(text)) break
          const lease = this.inputLease
          if (!lease || !utteranceId) break
          this.cancelSpeech()
          this.setPhase('thinking')
          this.emit({ event: 'final', text, utteranceId, ...lease })
        }
        break
      case 'error':
        this.setPhase('error', typeof message.message === 'string' ? message.message : 'Apple Speech failed.')
        break
      default:
        break
    }
  }

  private handleDictateInputLine(message: Record<string, unknown>): void {
    const lease = this.dictateLease
    if (!lease) return
    switch (message.event) {
      case 'speechStarted':
        this.dictateUtterances.start()
        break
      case 'partial':
        if (typeof message.text === 'string' && meaningfulTranscript(message.text)) {
          const text = message.text.trim()
          const utteranceId = this.dictateUtterances.current()
          this.emit({ event: 'dictate-partial', text, utteranceId, ...lease })
        }
        break
      case 'final':
        if (typeof message.text === 'string' && meaningfulTranscript(message.text)) {
          const text = message.text.trim()
          const utteranceId = this.dictateUtterances.finalize()
          if (!utteranceId) break
          this.emit({ event: 'dictate-final', text, utteranceId, ...lease })
        }
        break
      case 'error': {
        const text = typeof message.message === 'string' ? message.message : 'Apple Speech failed.'
        this.emit({ event: 'dictate-error', message: text, ...lease })
        break
      }
      default:
        break
    }
  }

  private handleTtsLine(line: string): void {
    const message = parseJsonLine(line)
    if (!message) return
    switch (message.event) {
      case 'ready':
        this.resolveTtsReady?.()
        this.resolveTtsReady = undefined
        this.rejectTtsReady = undefined
        this.ttsReady = undefined
        break
      case 'audio':
        if (
          typeof message.speechId === 'string'
          && message.speechId === this.currentSpeech?.speechId
          && typeof message.sequence === 'number'
          && typeof message.sampleRate === 'number'
          && typeof message.pcmBase64 === 'string'
        ) {
          if (this.currentSpeech.startedAt === undefined) {
            this.currentSpeech.startedAt = Date.now()
            if (this.currentSpeech.kind === 'response') {
              this.holdingPhrases?.cancel()
              this.clearHoldingCandidate()
            }
            this.emit({
              event: 'speech-started',
              speechId: message.speechId,
              ...(this.currentSpeech.clientTag ? { clientTag: this.currentSpeech.clientTag } : {}),
            })
          }
          this.currentSpeech.audioDurationMs += pcmDurationMs(message.pcmBase64, message.sampleRate)
          this.setPhase('speaking')
          this.refreshPlaybackMicGate()
          this.emit({
            event: 'audio',
            speechId: message.speechId,
            sequence: message.sequence,
            sampleRate: message.sampleRate,
            pcmBase64: message.pcmBase64,
          })
        }
        break
      case 'done':
        if (message.speechId === this.currentSpeech?.speechId) {
          const completed = this.currentSpeech
          if (!completed) break
          const speechId = completed.speechId
          const cancelled = message.cancelled === true
          this.rememberPlaybackEcho(completed)
          this.currentSpeech = undefined
          this.closePlaybackMicGate(completed)
          this.emit({ event: 'audio-done', speechId, cancelled })
          if (cancelled) {
            if (!this.startNextSpeech() && this.activeSessionId) this.setPhase('listening')
          } else {
            this.continueAfterPlayback(completed)
          }
        }
        break
      case 'error':
        if (this.ttsReady && typeof message.speechId !== 'string') {
          this.rejectTtsReady?.(new Error(typeof message.message === 'string' ? message.message : 'Kokoro model loading failed.'))
        }
        if (this.currentSpeech && message.speechId === this.currentSpeech.speechId) {
          const completed = this.currentSpeech
          this.rememberPlaybackEcho(completed)
          this.currentSpeech = undefined
          this.closePlaybackMicGate(completed)
        }
        this.emit({ event: 'audio-cancel', ...(typeof message.speechId === 'string' ? { speechId: message.speechId } : {}) })
        this.startNextSpeech()
        this.setPhase('error', typeof message.message === 'string' ? message.message : 'Kokoro synthesis failed.')
        break
      default:
        break
    }
  }

  private enqueueSpeech(
    text: string,
    kind: SpeechKind,
    replace: boolean,
    summaryHandoff: boolean,
    clientTag?: string,
  ): void {
    if (!this.activeSessionId || !this.ttsProcess) return
    if (replace) this.cancelSpeech()
    if (summaryHandoff) this.dropUnstartedResponseSpeech()
    this.speechQueue.push({
      speechId: randomUUID(),
      text,
      kind,
      ...(clientTag ? { clientTag } : {}),
      audioDurationMs: 0,
    })
    this.startNextSpeech()
  }

  private startNextSpeech(): boolean {
    if (this.currentSpeech || this.playbackTimer) return false
    const next = this.speechQueue.shift()
    if (!next) return false
    this.currentSpeech = next
    const config = this.requireConfig()
    this.writeTts({
      command: 'speak',
      speechId: next.speechId,
      text: next.text,
      rate: config.speechRate,
      voice: config.voice,
    })
    return true
  }

  private cancelSpeech(): void {
    this.cancelSummary()
    this.holdingPhrases?.cancel()
    this.clearHoldingCandidate()
    this.clearPlaybackTimer()
    this.speechQueue.length = 0
    const current = this.currentSpeech
    const speechId = current?.speechId
    if (current) this.rememberPlaybackEcho(current)
    // A cancel after audible playback still leaves a decaying acoustic tail
    // plus recognizer lag; keep the gate shut briefly. A cancel before the
    // first chunk (or with no current speech) played nothing, so a genuine
    // barge-in final must not be suppressed by a fresh tail here.
    if (current?.startedAt !== undefined) this.closePlaybackMicGate()
    if (speechId) this.writeTts({ command: 'cancel', speechId })
    this.currentSpeech = undefined
    this.emit({ event: 'audio-cancel', ...(speechId ? { speechId } : {}) })
  }

  private isPlaybackEcho(text: string): boolean {
    return isLikelyPlaybackEcho(text, this.playbackReferences())
  }

  private playbackReferences(): string[] {
    const now = Date.now()
    for (let index = this.recentSpeechEchoes.length - 1; index >= 0; index -= 1) {
      if ((this.recentSpeechEchoes[index]?.expiresAt ?? 0) <= now) this.recentSpeechEchoes.splice(index, 1)
    }
    const references = this.recentSpeechEchoes.map((entry) => entry.text)
    if (this.currentSpeech?.startedAt !== undefined) references.push(this.currentSpeech.text)
    // Apple Speech can wait for silence and fold several consecutive TTS
    // sentences into one transcript. Compare their combined playback history
    // as well as each sentence individually.
    if (references.length > 1) references.push(references.join(' '))
    return references
  }

  private rememberPlaybackEcho(speech: QueuedSpeech): void {
    if (speech.startedAt === undefined) return
    this.recentSpeechEchoes.push({ text: speech.text, expiresAt: Date.now() + 30_000 })
    if (this.recentSpeechEchoes.length > 32) this.recentSpeechEchoes.splice(0, this.recentSpeechEchoes.length - 32)
  }

  private refreshPlaybackMicGate(): void {
    // Anchor the gate to the estimated audible playout end, not just a fixed
    // window after the last SSE chunk: with slow synthesis or queued client
    // audio the last sentence is still audible long after chunks arrive, and
    // a bare `now + 1200 ms` would reopen the mic early and leak echo.
    const now = Date.now()
    this.micGateUntil = Math.max(now + PLAYBACK_GATE_ACTIVE_MS, this.estimatedPlaybackEndMs(now))
  }

  private closePlaybackMicGate(completed?: QueuedSpeech): void {
    const now = Date.now()
    const audibleEnd = this.estimatedPlaybackEndMs(now, completed)
    this.micGateUntil = Math.max(now + PLAYBACK_GATE_TAIL_MS, audibleEnd + PLAYBACK_GATE_TAIL_MS)
  }

  private estimatedPlaybackEndMs(now: number, speech?: QueuedSpeech): number {
    const current = speech ?? this.currentSpeech
    if (current?.startedAt === undefined) return now
    return current.startedAt + current.audioDurationMs + PLAYBACK_TAIL_MARGIN_MS
  }

  private isGateActive(): boolean {
    return Date.now() < this.micGateUntil
  }

  private isGatedLoopback(text: string): boolean {
    if (!this.isGateActive()) return false
    // Inside the audible-playback window the gate no longer drops every bare
    // transcript: unrelated speech ("Actually use the backup instead") must
    // still barge in, so only echo-suspect input counts as loopback here.
    // Explicit interruptions ("stop", "wait", ...) always break through.
    if (EXPLICIT_BARGE_IN.test(text)) return false
    if (this.isPlaybackEcho(text)) return true
    return sharesPlaybackWords(text, this.playbackReferences())
  }

  private enqueueHoldingPhrase(requestId: string, text: string): void {
    const holding: QueuedSpeech = {
      speechId: randomUUID(),
      text,
      kind: 'local',
      clientTag: `holding:${requestId}`,
      audioDurationMs: 0,
    }
    const current = this.currentSpeech
    if (current?.kind === 'response' && current.startedAt === undefined) {
      this.writeTts({ command: 'cancel', speechId: current.speechId })
      this.currentSpeech = undefined
      this.speechQueue.unshift(current)
    }
    this.speechQueue.unshift(holding)
    this.startNextSpeech()
  }

  private offerHoldingPhrase(requestId: string, result: HoldingPhraseResult): void {
    this.clearHoldingCandidate()
    const text = validateHoldingPhrase(result.text)
    if (!text) return
    const normalized = { ...result, text }
    const timer = setTimeout(() => {
      if (this.holdingCandidate?.requestId === requestId) this.holdingCandidate = undefined
    }, 500)
    timer.unref()
    this.holdingCandidate = { requestId, result: normalized, timer }
    this.emit({ event: 'holding-ready', requestId, text, source: result.source })
  }

  private acceptHoldingPhrase(requestId: string): boolean {
    const candidate = this.holdingCandidate
    if (!candidate || candidate.requestId !== requestId || !validateHoldingPhrase(candidate.result.text)) return false
    this.clearHoldingCandidate()
    this.enqueueHoldingPhrase(requestId, candidate.result.text)
    return true
  }

  private clearHoldingCandidate(): void {
    if (this.holdingCandidate) clearTimeout(this.holdingCandidate.timer)
    this.holdingCandidate = undefined
  }

  private dropUnstartedResponseSpeech(): void {
    for (let index = this.speechQueue.length - 1; index >= 0; index -= 1) {
      if (this.speechQueue[index]?.kind === 'response') this.speechQueue.splice(index, 1)
    }
    const current = this.currentSpeech
    if (!current || current.kind !== 'response' || current.startedAt !== undefined) return
    this.writeTts({ command: 'cancel', speechId: current.speechId })
    this.currentSpeech = undefined
  }

  private continueAfterPlayback(completed: QueuedSpeech): void {
    const remainingMs = completed.startedAt === undefined
      ? 0
      : Math.max(0, completed.startedAt + completed.audioDurationMs + PLAYBACK_TAIL_MARGIN_MS - Date.now())
    if (remainingMs <= 0) {
      if (!this.startNextSpeech() && this.activeSessionId) this.setPhase('listening')
      return
    }
    this.clearPlaybackTimer()
    this.playbackTimer = setTimeout(() => {
      this.playbackTimer = undefined
      if (!this.startNextSpeech() && this.activeSessionId) this.setPhase('listening')
    }, remainingMs)
    this.playbackTimer.unref?.()
  }

  private clearPlaybackTimer(): void {
    if (this.playbackTimer) clearTimeout(this.playbackTimer)
    this.playbackTimer = undefined
  }

  private startSummary(request: VoiceSummaryRequest): void {
    this.cancelSummary()
    const controller = new AbortController()
    const task = { id: request.summaryId, controller }
    this.summaryTask = task
    let outputChars = 0
    let producedText = false
    void this.generateSummary!(request, (delta) => {
      if (this.summaryTask !== task || controller.signal.aborted || !delta) return
      const remaining = MAX_SUMMARY_OUTPUT_CHARS - outputChars
      if (remaining <= 0) return controller.abort()
      const bounded = delta.slice(0, remaining)
      if (!bounded) return
      outputChars += bounded.length
      if (/\S/u.test(bounded)) producedText = true
      this.emit({ event: 'summary-delta', summaryId: request.summaryId, text: bounded })
      if (outputChars >= MAX_SUMMARY_OUTPUT_CHARS) controller.abort()
    }, controller.signal).then((ok) => {
      if (this.summaryTask !== task) return
      this.summaryTask = undefined
      this.emit({ event: 'summary-done', summaryId: request.summaryId, ok: ok && producedText })
    }).catch((error: unknown) => {
      if (this.summaryTask !== task) return
      this.summaryTask = undefined
      if (!controller.signal.aborted) this.log.warn(`[kokoro-live-voice:summary] ${safeMessage(error)}`)
      this.emit({ event: 'summary-done', summaryId: request.summaryId, ok: false })
    })
  }

  private cancelSummary(): void {
    const task = this.summaryTask
    this.summaryTask = undefined
    task?.controller.abort()
  }

  private setPhase(phase: RuntimePhase, message?: string): void {
    this.phase = phase
    this.emit({
      event: 'state',
      phase,
      active: this.activeSessionId !== undefined,
      muted: this.muted,
      ...(this.activeSessionId ? { sessionId: this.activeSessionId } : {}),
      ...(message ? { message } : {}),
    })
  }

  private emit(event: RuntimeEvent): void {
    for (const client of [...this.clients]) {
      if (client.destroyed) this.dropClient(client)
    }
    const ownerClient = this.inputLease ? this.clientsById.get(this.inputLease.clientId) : undefined
    const dictateClient = this.dictateLease ? this.clientsById.get(this.dictateLease.clientId) : undefined
    for (const client of runtimeEventRecipients(event, this.clients, this.interactiveClients, this.nativeClients, ownerClient, dictateClient)) {
      this.emitTo(client, event)
    }
  }

  private emitTo(client: ServerResponse, event: RuntimeEvent): void {
    if (client.destroyed) return this.dropClient(client)
    client.write(`data:${JSON.stringify(event)}\n\n`)
    // `write() === false` only means Node crossed its small high-water mark;
    // a single valid PCM chunk routinely does that. Let the loopback socket
    // drain normally and disconnect only if its actual queued bytes grow to a
    // bounded level, which distinguishes a stalled observer from normal audio.
    if (client.writableLength > MAX_SSE_BUFFER_BYTES) this.dropClient(client)
  }

  private dropClient(client: ServerResponse): void {
    const clientId = this.clientIds.get(client)
    const disconnectedOwner = this.inputLease?.clientId === clientId
    const disconnectedDictator = this.dictateLease?.clientId === clientId
    this.removeClient(client)
    client.destroy()
    if (disconnectedOwner && this.inputLease) this.scheduleOwnerDisconnect(this.inputLease)
    if (disconnectedDictator && this.dictateLease) this.scheduleDictateDisconnect(this.dictateLease)
  }

  private scheduleTtsShutdown(): void {
    this.clearShutdownTimer()
    this.shutdownTimer = setTimeout(() => {
      const child = this.ttsProcess
      if (!child) return
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ command: 'shutdown' })}\n`)
      this.ttsProcess = undefined
      this.currentSpeech = undefined
      this.speechQueue.length = 0
      const forceKill = setTimeout(() => {
        if (child.exitCode === null) child.kill()
      }, 12_000)
      forceKill.unref()
    }, KOKORO_SHUTDOWN_DELAY_MS)
    this.shutdownTimer.unref?.()
  }

  private clearShutdownTimer(): void {
    if (this.shutdownTimer) clearTimeout(this.shutdownTimer)
    this.shutdownTimer = undefined
  }

  private removeClient(client: ServerResponse): void {
    this.clients.delete(client)
    this.interactiveClients.delete(client)
    this.nativeClients.delete(client)
    const clientId = this.clientIds.get(client)
    this.clientIds.delete(client)
    if (clientId && this.clientsById.get(clientId) === client) this.clientsById.delete(clientId)
  }

  private scheduleOwnerDisconnect(lease: InputLease): void {
    this.clearOwnerDisconnectTimer()
    this.ownerDisconnectTimer = setTimeout(() => {
      if (sameInputLease(this.inputLease, lease) && !this.clientsById.has(lease.clientId)) void this.stop()
    }, 5_000)
    this.ownerDisconnectTimer.unref?.()
  }

  private clearOwnerDisconnectTimer(): void {
    if (this.ownerDisconnectTimer) clearTimeout(this.ownerDisconnectTimer)
    this.ownerDisconnectTimer = undefined
  }

  private scheduleDictateDisconnect(lease: InputLease): void {
    this.clearDictateDisconnectTimer()
    this.dictateDisconnectTimer = setTimeout(() => {
      if (sameInputLease(this.dictateLease, lease) && !this.clientsById.has(lease.clientId)) void this.dictateStop()
    }, 5_000)
    this.dictateDisconnectTimer.unref?.()
  }

  private clearDictateDisconnectTimer(): void {
    if (this.dictateDisconnectTimer) clearTimeout(this.dictateDisconnectTimer)
    this.dictateDisconnectTimer = undefined
  }

  private ownsLease(body: JsonRecord): boolean {
    return ownsInputLease(this.inputLease, body)
  }

  private ownsDictateLease(body: JsonRecord): boolean {
    return ownsInputLease(this.dictateLease, body)
  }

  private async waitForClient(clientId: string): Promise<void> {
    const deadline = Date.now() + 1_000
    while (!this.clientsById.has(clientId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  private writeInput(message: JsonRecord): void {
    if (this.inputProcess?.stdin.writable) this.inputProcess.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private writeTts(message: JsonRecord): void {
    if (this.ttsProcess?.stdin.writable) this.ttsProcess.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private requireConfig(): ResolvedVoiceConfig {
    if (!this.config) throw new Error('Kokoro Live Voice has not initialized.')
    return this.config
  }
}

export function runtimeEventRecipients<T>(
  event: RuntimeEvent,
  clients: ReadonlySet<T>,
  interactiveClients: ReadonlySet<T>,
  nativeClients: ReadonlySet<T>,
  ownerClient?: T,
  dictateClient?: T,
): readonly T[] {
  if (event.event === 'audio-cancel') return [...clients]
  if (event.event === 'dictate-partial'
    || event.event === 'dictate-final'
    || event.event === 'dictate-error') return dictateClient === undefined ? [] : [dictateClient]
  if (event.event === 'partial'
    || event.event === 'final'
    || event.event === 'speech-started'
    || event.event === 'holding-ready'
    || event.event === 'summary-delta'
    || event.event === 'summary-done') return ownerClient === undefined ? [] : [ownerClient]
  if (event.event !== 'audio' && event.event !== 'audio-done') return [...clients]

  if (ownerClient !== undefined) return [ownerClient]

  // PCM has exactly one playback owner. The Dock observer wins when present;
  // otherwise browser clients receive it and only the page that started Live
  // Voice plays it. Broadcasting PCM to both made an open background Harness
  // tab audibly shadow the Dock app with slightly different latency.
  const native = nativeClients.values().next().value
  return native === undefined ? [...interactiveClients] : [native]
}

export function sameInputLease(left: InputLease | undefined, right: InputLease | undefined): boolean {
  return Boolean(left && right
    && left.clientId === right.clientId
    && left.leaseId === right.leaseId
    && left.sessionId === right.sessionId)
}

export function ownsInputLease(lease: InputLease | undefined, command: JsonRecord): boolean {
  return Boolean(lease
    && command.clientId === lease.clientId
    && command.leaseId === lease.leaseId
    && (command.sessionId === undefined || command.sessionId === lease.sessionId))
}

export class InputUtteranceGate {
  private utteranceId: string | undefined
  private finalized = false

  start(): string {
    this.utteranceId = randomUUID()
    this.finalized = false
    return this.utteranceId
  }

  current(): string {
    return this.utteranceId ?? this.start()
  }

  finalize(): string | undefined {
    if (this.finalized) return undefined
    const utteranceId = this.current()
    this.finalized = true
    return utteranceId
  }

  reset(): void {
    this.utteranceId = undefined
    this.finalized = false
  }
}

export async function resolveVoiceConfig(raw: VoicePluginConfig): Promise<ResolvedVoiceConfig> {
  const liveVoiceRoot = defaultLiveVoiceRoot()
  const rawBackendExplicit = typeof raw.ttsBackend === 'string' && raw.ttsBackend.trim().length > 0
  const ttsBackend = resolveTtsBackend(raw.ttsBackend)
  const kokoroRoot = resolveHome(raw.runtimeRoot?.trim() || defaultKokoroRoot(liveVoiceRoot))
  const pocketRoot = resolveHome(raw.pocketRuntimeRoot?.trim() || defaultPocketRoot(liveVoiceRoot))
  const pocket = ttsBackend === 'pocket'
  const runtimeRoot = pocket ? pocketRoot : kokoroRoot
  const saved = await loadSavedSettingsForResolve()
  const ttsBackendForResolve = rawBackendExplicit ? ttsBackend : (saved.ttsBackend === 'pocket' ? 'pocket' as const : 'kokoro' as const)
  const pocketVoice = nonBlank(raw.pocketVoice) ?? nonBlank(saved.pocketVoice) ?? DEFAULT_VOICE_DEFAULTS.pocketVoice
  const voice = pocket ? pocketVoice : nonBlank(raw.voice) ?? (ttsBackendForResolve === 'pocket' ? pocketVoice : DEFAULT_VOICE_DEFAULTS.voice)
  return {
    ttsBackend,
    runtimeRoot,
    pythonPath: resolveHome(pocket
      ? raw.pocketPythonPath?.trim() || path.join(pocketRoot, '.venv', 'bin', 'python')
      : raw.pythonPath?.trim() || path.join(kokoroRoot, '.venv', 'bin', 'python')),
    modelPath: resolveHome(pocket ? pocketRoot : raw.modelPath?.trim() || path.join(kokoroRoot, 'model')),
    helperPath: resolveHome(raw.helperPath?.trim() || path.join(liveVoiceRoot, 'bin', 'dsh-live-voice-input-helper')),
    sidecarPath: resolveHome(pocket
      ? raw.pocketSidecarPath?.trim() || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'pocket-tts-sidecar.py')
      : raw.sidecarPath?.trim() || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'kokoro-tts-sidecar.py')),
    locale: nonBlank(raw.locale) ?? nonBlank(saved.locale) ?? defaultSpeechLocale(),
    voice,
    pocketVoice,
    endTurnMs: clamp(raw.endTurnMs ?? saved.endTurnMs, 900, 2_500, DEFAULT_VOICE_DEFAULTS.endTurnMs),
    speechRate: clamp(raw.speechRate ?? saved.speechRate, 0.8, 1.2, DEFAULT_VOICE_DEFAULTS.speechRate),
    acknowledgementDelayMs: clamp(raw.acknowledgementDelayMs ?? saved.acknowledgementDelayMs, 0, 1_000, DEFAULT_VOICE_DEFAULTS.acknowledgementDelayMs),
    holdingPhraseDelayMs: clamp(raw.holdingPhraseDelayMs ?? saved.holdingPhraseDelayMs, 250, 1_500, DEFAULT_VOICE_DEFAULTS.holdingPhraseDelayMs),
  }
}

export function resolveTtsBackend(value: unknown): TtsBackend {
  return typeof value === 'string' && value.trim().toLowerCase() === 'pocket' ? 'pocket' : 'kokoro'
}

const readJsonBody = readHttpJsonObject

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function parseJsonLine(line: string): JsonRecord | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function validSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/u.test(value)
    ? value
    : undefined
}

function validSummaryRequest(value: JsonRecord): VoiceSummaryRequest | undefined {
  const summaryId = boundedPlainString(value.summaryId, 200)
  const responseText = boundedText(value.responseText, MAX_SUMMARY_SOURCE_CHARS)
  const spokenLead = boundedText(value.spokenLead, MAX_SUMMARY_CONTEXT_CHARS, true)
  const userText = boundedText(value.userText, MAX_SUMMARY_CONTEXT_CHARS, true)
  if (!summaryId || !responseText || spokenLead === undefined || userText === undefined) return undefined
  return { summaryId, responseText, spokenLead, userText }
}

function validHoldingPhraseRequest(value: JsonRecord): HoldingPhraseRequest | undefined {
  const requestId = boundedPlainString(value.requestId, 200)
  const userText = boundedText(value.userText, MAX_SUMMARY_CONTEXT_CHARS)
  const activity = isHoldingActivity(value.activity) ? value.activity : undefined
  return requestId && userText && activity ? { requestId, userText, activity } : undefined
}

function isHoldingActivity(value: unknown): value is HoldingActivity {
  return value === 'responding' || value === 'checking' || value === 'reviewing' || value === 'working'
}

function boundedPlainString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized && normalized.length <= maximum && !/[\u0000-\u001f]/u.test(normalized) ? normalized : undefined
}

function boundedText(value: unknown, maximum: number, allowEmpty = false): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if ((!normalized && !allowEmpty) || normalized.length > maximum || /\u0000/u.test(normalized)) return undefined
  return normalized
}

const EXPLICIT_BARGE_IN = /(?:\b(?:stop|wait|pause|cancel|quiet)\b|^\s*(?:please\s+)?(?:no|hold on|hang on)\b)/iu

export function isLikelyPlaybackEcho(transcript: string, references: readonly string[]): boolean {
  if (EXPLICIT_BARGE_IN.test(transcript)) return false
  const words = normalizedSpeechWords(transcript)
  if (words.length === 1) {
    // Single-word finals ("ready", "done") previously bypassed every echo
    // check and were submitted as new user turns when the recognizer emitted
    // only the tail of a played sentence. A lone word copied from recent
    // playback is loopback, not a new utterance.
    const lone = words[0]!
    for (const reference of references) {
      if (normalizedSpeechWords(reference).includes(lone)) return true
    }
    return false
  }
  if (words.length < 2) return false
  const normalized = words.join(' ')
  for (const reference of references) {
    const referenceWords = normalizedSpeechWords(reference)
    if (referenceWords.length < 2) continue
    const referenceText = referenceWords.join(' ')
    if (referenceText.includes(normalized) || normalized.includes(referenceText)) return true
    const transcriptSet = new Set(words)
    const referenceSet = new Set(referenceWords)
    let shared = 0
    for (const word of transcriptSet) if (referenceSet.has(word)) shared += 1
    const smaller = Math.min(transcriptSet.size, referenceSet.size)
    const lengthRatio = Math.min(words.length, referenceWords.length) / Math.max(words.length, referenceWords.length)
    if (smaller >= 2 && shared / smaller >= 0.8 && lengthRatio >= 0.55) return true
  }
  return false
}

function sharesPlaybackWords(transcript: string, references: readonly string[]): boolean {
  const words = new Set(normalizedSpeechWords(transcript))
  if (words.size === 0) return false
  const referenceWords = new Set<string>()
  for (const reference of references) {
    for (const word of normalizedSpeechWords(reference)) referenceWords.add(word)
  }
  let shared = 0
  let sharedContent = false
  for (const word of words) {
    if (referenceWords.has(word)) {
      shared += 1
      if (word.length >= 4) sharedContent = true
    }
  }
  // Echo paraphrases of audible playback share its vocabulary; a genuinely
  // unrelated utterance ("Actually use the backup instead" vs a deployment
  // status) shares at most a stopword. Two shared words, or one shared
  // content word, marks the transcript as loopback-suspect.
  return shared >= 2 || sharedContent
}

function shouldDeferShortPartial(transcript: string): boolean {
  return normalizedSpeechWords(transcript).length < 2 && !EXPLICIT_BARGE_IN.test(transcript)
}

function normalizedSpeechWords(value: string): string[] {
  return value.normalize('NFKC').toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) ?? []
}

function meaningfulTranscript(value: string): boolean {
  const normalized = value.normalize('NFKC').replace(/^\s*[\[(](?:noise|silence|music|inaudible|unintelligible)[\])]\s*$/iu, '').trim()
  return /[\p{L}\p{N}]/u.test(normalized)
}

function isSpeechKind(value: unknown): value is SpeechKind {
  return value === 'response' || value === 'local' || value === 'system'
}

function resolveHome(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : path.resolve(value)
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function clamp(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback
}

async function loadSavedSettingsForResolve(): Promise<Record<string, unknown>> {
  try {
    const { loadVoiceSettings } = await import('./voice-settings.ts')
    return await loadVoiceSettings() as unknown as Record<string, unknown>
  } catch {
    return {}
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pcmDurationMs(pcmBase64: string, sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0
  return (Buffer.byteLength(pcmBase64, 'base64') / Float32Array.BYTES_PER_ELEMENT / sampleRate) * 1_000
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
