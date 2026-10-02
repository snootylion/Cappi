import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AssistantBlock, AssistantMessageNode, LegacyConversationSlice } from '@deepseek-ai/dsh-client-ui-chat/client'
import { extractCompletedVoiceSentences, flushVoiceFragment, spokenVoiceSummaryText, stripStreamingVoiceCode } from '../shared/voice-text.ts'
import { validateHoldingPhrase } from '../shared/holding-phrase.ts'
import { hasNativeVoiceHost, postFloatingVoicePanelState, postNativeVoiceMessage } from './native-host.ts'

const EVENTS_PATH = '/dsh-kokoro-live-voice/events'
const COMMAND_PATH = '/dsh-kokoro-live-voice/command'

export type VoiceUiPhase = 'idle' | 'starting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'muted' | 'error'

export type VoiceTtsBackend = 'kokoro' | 'pocket'

export interface VoiceUiState {
  readonly phase: VoiceUiPhase
  readonly ttsBackend: VoiceTtsBackend
  readonly activeSessionId?: string
  readonly ownedSessionId?: string
  readonly muted: boolean
  readonly message?: string
}

export interface VoiceConversationSnapshot extends LegacyConversationSlice {
  readonly running: boolean
}

type RuntimeMessage = Record<string, unknown>
type Listener = () => void

export interface SpeechSummaryRequest {
  readonly summaryId: string
  readonly responseText: string
  readonly spokenLead: string
}

export interface SpeechOptions {
  readonly clientTag?: string
  readonly summaryHandoff?: boolean
}

interface OpeningSpeech {
  readonly text: string
  readonly clientTag: string
}

interface FinalSpeechPlan {
  readonly finalText: string
  readonly openings: readonly OpeningSpeech[]
}

interface PendingSpeechSummary {
  readonly id: string
  readonly fallbackText: string
  buffer: string
  spokeSummary: boolean
  readonly plan: FinalSpeechPlan
  readonly spokenOpeningCount: number
}

const FINAL_MESSAGE_GRACE_MS = 1_000

export class ResponseSpeechPlanner {
  private activeTurn: number | undefined
  private baselineTurn = -1
  private stepKey: string | undefined
  private lastText = ''
  private buffer = ''
  private held = ''
  private sentenceCount = 0
  private readonly spokenLead: string[] = []
  private readonly openingSpeech: OpeningSpeech[] = []
  private readonly startedSpeechTags = new Set<string>()
  private previousRunning = false
  private previousRunningCalls = 0
  private responseStarted = false
  private pendingSummary: PendingSpeechSummary | undefined
  private deferredSummary: FinalSpeechPlan | undefined
  private awaitingFinalMessage = false
  private finalMessageTimer: ReturnType<typeof setTimeout> | undefined
  private latestSnapshot: VoiceConversationSnapshot | undefined
  private lastUserSeq = -1

  constructor(
    private readonly speak: (text: string, options?: SpeechOptions) => void,
    private readonly onResponseStarted: () => void,
    private readonly requestSummary: (request: SpeechSummaryRequest) => void,
    private readonly playbackAware = false,
    private readonly onUserTurnBoundary?: () => void,
  ) {}

  reset(snapshot: VoiceConversationSnapshot): void {
    this.clearFinalMessageWait()
    this.activeTurn = undefined
    this.baselineTurn = latestAssistantTurn(snapshot)
    this.lastUserSeq = latestUserSeq(snapshot)
    this.stepKey = undefined
    this.lastText = ''
    this.buffer = ''
    this.held = ''
    this.sentenceCount = 0
    this.spokenLead.length = 0
    this.openingSpeech.length = 0
    this.startedSpeechTags.clear()
    this.previousRunning = snapshot.running
    this.previousRunningCalls = snapshot.runningCalls.length
    this.responseStarted = false
    this.pendingSummary = undefined
    this.deferredSummary = undefined
    this.latestSnapshot = snapshot
  }

  update(snapshot: VoiceConversationSnapshot): void {
    this.latestSnapshot = snapshot
    const userSeq = latestUserSeq(snapshot)
    if (userSeq !== -1 && userSeq !== this.lastUserSeq) {
      // A new user message arrived — typed in the composer or spoken. The
      // previous turn's streamed summary and queued audio belong to a finished
      // exchange; speaking them here would "re-read" the old response over the
      // new one. Drop every negotiated piece and let the upcoming partial
      // establish the next turn from scratch.
      this.reset(snapshot)
      this.onUserTurnBoundary?.()
    }
    const callCount = snapshot.runningCalls.length
    if (callCount > 0 && this.previousRunningCalls === 0) this.flushBlock()
    if (callCount === 0 && this.previousRunningCalls > 0) this.resetBlock()
    this.previousRunningCalls = callCount

    const partial = snapshot.partial
    if (partial) {
      if (this.activeTurn === undefined) this.activeTurn = partial.turn
      if (partial.turn === this.activeTurn) {
        const nextStepKey = `${partial.turn}:${partial.step}`
        if (this.stepKey !== nextStepKey) {
          if (this.stepKey !== undefined) this.flushBlock()
          this.stepKey = nextStepKey
          this.lastText = ''
        }
        const rawText = partial.blocks.flatMap((block) => block.kind === 'text' ? [block.text] : []).join('')
        const text = stripStreamingVoiceCode(rawText)
        const delta = text.startsWith(this.lastText) ? text.slice(this.lastText.length) : text
        this.lastText = text
        if (delta) {
          if (!this.responseStarted) {
            this.responseStarted = true
            this.onResponseStarted()
          }
          this.push(delta)
        }
      }
    }

    if (!snapshot.running && this.activeTurn === undefined) {
      this.activeTurn = latestCompletedAssistantTurnAfter(snapshot, this.baselineTurn)
    }
    if (this.previousRunning && !snapshot.running) this.finishOrWait(snapshot)
    else if (this.awaitingFinalMessage && !snapshot.running && hasDefinitiveFinalAssistant(snapshot, this.activeTurn)) this.finish(snapshot)
    this.previousRunning = snapshot.running
  }

  private push(delta: string): void {
    this.buffer += delta
    const extracted = extractCompletedVoiceSentences(this.buffer)
    this.buffer = extracted.remainder
    for (const sentence of extracted.sentences) {
      const spoken = spokenVoiceSummaryText(sentence)
      if (!spoken) continue
      if (this.sentenceCount < 2) {
        const clientTag = globalThis.crypto.randomUUID()
        this.speak(spoken, this.playbackAware ? { clientTag } : undefined)
        this.spokenLead.push(spoken)
        this.openingSpeech.push({ text: spoken, clientTag })
        this.sentenceCount += 1
      } else {
        this.held = `${this.held}${this.held ? ' ' : ''}${spoken}`
      }
    }
  }

  private flushBlock(): void {
    const text = `${this.held}${this.held && this.buffer ? ' ' : ''}${this.buffer}`.trim()
    if (text) this.speakCompleteText(text)
    this.resetBlock()
  }

  handleSummaryDelta(summaryId: string, delta: string): void {
    const pending = this.pendingSummary
    if (!pending || pending.id !== summaryId || !delta) return
    pending.buffer += delta
    const extracted = extractCompletedVoiceSentences(pending.buffer)
    pending.buffer = extracted.remainder
    // No sentence/word cap: the model is instructed to stay succinct, but a
    // longer summary is read in full rather than cut off mid-thought.
    for (const sentence of extracted.sentences) this.speakSummarySentence(pending, sentence)
  }

  finishSummary(summaryId: string, ok: boolean): void {
    const pending = this.pendingSummary
    if (!pending || pending.id !== summaryId) return
    if (ok) {
      const tail = flushVoiceFragment(pending.buffer)
      if (tail) this.speakSummarySentence(pending, tail)
    }
    if (!pending.spokeSummary) this.speakCompleteText(spokenVoiceSummaryText(pending.fallbackText))
    this.pendingSummary = undefined
    this.deferredSummary = undefined
  }

  handleSpeechStarted(clientTag: string): void {
    if (!clientTag) return
    this.startedSpeechTags.add(clientTag)
    const plan = this.pendingSummary?.plan ?? this.deferredSummary
    if (!plan) return
    const spokenOpeningCount = contiguousStartedOpenings(plan.openings, this.startedSpeechTags)
    if (spokenOpeningCount === 0) return
    if (this.pendingSummary && this.pendingSummary.plan === plan) {
      // Rebase the remainder boundary for the visible fallback, but never
      // re-request the summary: another unstated opening beginning during an
      // in-flight generation would start a second same-content synthesis and
      // replay the previous summary audio over the live response.
      if (spokenOpeningCount > this.pendingSummary.spokenOpeningCount) {
        this.pendingSummary = {
          ...this.pendingSummary,
          spokenOpeningCount,
          fallbackText: finalRemainderAfterSpokenLead(plan.finalText, spokenOpeningCount),
        }
      }
      return
    }
    this.beginSummary(plan, spokenOpeningCount)
  }

  cancelSummary(): void {
    this.pendingSummary = undefined
    this.deferredSummary = undefined
  }

  dispose(): void {
    this.clearFinalMessageWait()
    this.pendingSummary = undefined
    this.deferredSummary = undefined
    this.latestSnapshot = undefined
  }

  private finishOrWait(snapshot: VoiceConversationSnapshot): void {
    if (hasDefinitiveFinalAssistant(snapshot, this.activeTurn)) {
      this.finish(snapshot)
      return
    }
    this.awaitingFinalMessage = true
    this.finalMessageTimer = setTimeout(() => {
      if (!this.awaitingFinalMessage || !this.latestSnapshot) return
      this.failOpenWithoutFinal()
    }, FINAL_MESSAGE_GRACE_MS)
  }

  private finish(snapshot: VoiceConversationSnapshot): void {
    this.clearFinalMessageWait()
    const finalText = findFinalAssistantText(snapshot, this.activeTurn)
    if (!finalText) return this.failOpenWithoutFinal()
    const streamText = stripStreamingVoiceCode(finalText)
    if (!this.lastText) {
      this.lastText = streamText
      this.push(streamText)
    } else if (streamText.startsWith(this.lastText)) {
      this.push(streamText.slice(this.lastText.length))
      this.lastText = streamText
    }
    const plan: FinalSpeechPlan = { finalText, openings: [...this.openingSpeech] }
    const spokenOpeningCount = this.playbackAware
      ? contiguousStartedOpenings(plan.openings, this.startedSpeechTags)
      : this.spokenLead.length
    if (this.playbackAware && spokenOpeningCount === 0 && plan.openings.length > 0) this.deferredSummary = plan
    else this.beginSummary(plan, spokenOpeningCount)
    this.resetBlock()
    this.activeTurn = undefined
    this.stepKey = undefined
    this.responseStarted = false
  }

  private failOpenWithoutFinal(): void {
    this.clearFinalMessageWait()
    const fallbackText = `${this.held}${this.held && this.buffer ? ' ' : ''}${this.buffer}`.trim()
    if (fallbackText) this.speakCompleteText(fallbackText)
    this.resetBlock()
    this.activeTurn = undefined
    this.stepKey = undefined
    this.responseStarted = false
  }

  private clearFinalMessageWait(): void {
    if (this.finalMessageTimer !== undefined) clearTimeout(this.finalMessageTimer)
    this.finalMessageTimer = undefined
    this.awaitingFinalMessage = false
  }

  private resetBlock(): void {
    this.lastText = ''
    this.buffer = ''
    this.held = ''
    this.sentenceCount = 0
    this.spokenLead.length = 0
    this.openingSpeech.length = 0
  }

  private speakCompleteText(text: string): void {
    const extracted = extractCompletedVoiceSentences(spokenVoiceSummaryText(text))
    for (const sentence of extracted.sentences) this.speak(sentence)
    const tail = flushVoiceFragment(extracted.remainder)
    if (tail) this.speak(tail)
  }

  private speakSummarySentence(pending: PendingSpeechSummary, text: string): void {
    const normalized = spokenVoiceSummaryText(text)
    if (!normalized) return
    this.speak(normalized, {
      summaryHandoff: !pending.spokeSummary && pending.spokenOpeningCount === 1 && pending.plan.openings.length > 1,
    })
    pending.spokeSummary = true
  }

  private beginSummary(plan: FinalSpeechPlan, spokenOpeningCount: number): void {
    const finalizedRemainder = finalRemainderAfterSpokenLead(plan.finalText, spokenOpeningCount)
    if (!finalizedRemainder) {
      this.pendingSummary = undefined
      this.deferredSummary = undefined
      return
    }
    const summaryId = globalThis.crypto.randomUUID()
    this.pendingSummary = {
      id: summaryId,
      fallbackText: finalizedRemainder,
      buffer: '',
      spokeSummary: false,
      plan,
      spokenOpeningCount,
    }
    this.deferredSummary = undefined
    this.requestSummary({
      summaryId,
      responseText: boundSummarySource(finalizedRemainder),
      spokenLead: plan.openings.slice(0, spokenOpeningCount).map((opening) => opening.text).join(' '),
    })
  }
}

function contiguousStartedOpenings(openings: readonly OpeningSpeech[], started: ReadonlySet<string>): number {
  let count = 0
  for (const opening of openings) {
    if (!started.has(opening.clientTag)) break
    count += 1
  }
  return count
}

function findFinalAssistantText(snapshot: VoiceConversationSnapshot, activeTurn: number | undefined): string {
  const assistants = snapshot.nodes.filter((node) => node.kind === 'assistant')
  const candidates = assistants.filter((candidate) => activeTurn === undefined || candidate.turn === activeTurn)
  // Tool-using turns end on a tool-call node with no text blocks; the spoken
  // remainder must come from the last node that actually contains text.
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate: AssistantMessageNode | undefined = candidates[index]
    if (!candidate) continue
    const text = candidate.blocks.flatMap((block: AssistantBlock) => block.kind === 'text' ? [block.text] : []).join('')
    if (text) return text
  }
  return ''
}

function latestAssistantTurn(snapshot: VoiceConversationSnapshot): number {
  return snapshot.nodes.flatMap((node) => node.kind === 'assistant' ? [node.turn] : []).at(-1) ?? -1
}

function latestUserSeq(snapshot: VoiceConversationSnapshot): number {
  return snapshot.nodes.reduce((latest, node) => node.kind === 'user' ? Math.max(latest, node.seq) : latest, -1)
}

function latestCompletedAssistantTurnAfter(snapshot: VoiceConversationSnapshot, baselineTurn: number): number | undefined {
  return snapshot.nodes.flatMap((node) => node.kind === 'assistant' && node.turn > baselineTurn && snapshot.turnEnds.has(node.turn)
    ? [node.turn]
    : []).at(-1)
}

function hasDefinitiveFinalAssistant(snapshot: VoiceConversationSnapshot, activeTurn: number | undefined): boolean {
  return activeTurn !== undefined
    && snapshot.turnEnds.has(activeTurn)
    && Boolean(findFinalAssistantText(snapshot, activeTurn))
}

function finalRemainderAfterSpokenLead(finalText: string, spokenSentenceCount: number): string {
  const normalized = spokenVoiceSummaryText(stripStreamingVoiceCode(finalText))
  const extracted = extractCompletedVoiceSentences(normalized)
  const sentences = [...extracted.sentences]
  const tail = flushVoiceFragment(extracted.remainder)
  if (tail) sentences.push(tail)
  return sentences.slice(spokenSentenceCount).join(' ')
}

function boundSummarySource(text: string): string {
  const maximum = 32_000
  if (text.length <= maximum) return text
  const half = Math.floor((maximum - 35) / 2)
  return `${text.slice(0, half)}\n\n[...middle omitted...]\n\n${text.slice(-half)}`
}

export class VoiceAudioPlayer {
  private static readonly OUTPUT_GAIN = 1.85
  private static readonly CANCELLED_SPEECH_TTL_MS = 30_000
  private context: AudioContext | undefined
  private gain: GainNode | undefined
  private limiter: DynamicsCompressorNode | undefined
  private speechId: string | undefined
  private nextStartAt = 0
  private readonly lastSequenceBySpeech = new Map<string, number>()
  // SSE audio chunks already in flight can arrive after the runtime cancelled
  // their speech. cancel() used to wipe the dedup map, so those stale chunks
  // replayed the previous turn's tail over the new response. Tombstones drop
  // them until they age out; speech IDs are UUIDs and never reused.
  private readonly cancelledSpeechAt = new Map<string, number>()
  private readonly sources = new Set<AudioBufferSourceNode>()

  unlock(): void {
    const context = this.context ?? new AudioContext({ latencyHint: 'interactive' })
    this.context = context
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
  }

  play(message: RuntimeMessage): void {
    if (
      typeof message.speechId !== 'string'
      || typeof message.sequence !== 'number'
      || typeof message.sampleRate !== 'number'
      || typeof message.pcmBase64 !== 'string'
      || !message.pcmBase64
    ) return
    const lastSequence = this.lastSequenceBySpeech.get(message.speechId)
    if (lastSequence !== undefined && message.sequence <= lastSequence) return
    if (this.isCancelledSpeech(message.speechId)) return
    this.lastSequenceBySpeech.set(message.speechId, message.sequence)
    if (this.lastSequenceBySpeech.size > 32) {
      const oldest = this.lastSequenceBySpeech.keys().next().value
      if (oldest !== undefined) this.lastSequenceBySpeech.delete(oldest)
    }
    if (message.speechId !== this.speechId) this.speechId = message.speechId
    const context = this.context ?? new AudioContext({ latencyHint: 'interactive', sampleRate: message.sampleRate })
    this.context = context
    if (!this.gain || !this.limiter) {
      this.gain = context.createGain()
      this.gain.gain.value = VoiceAudioPlayer.OUTPUT_GAIN
      this.limiter = context.createDynamicsCompressor()
      this.limiter.threshold.value = -7
      this.limiter.knee.value = 8
      this.limiter.ratio.value = 6
      this.limiter.attack.value = 0.003
      this.limiter.release.value = 0.18
      this.gain.connect(this.limiter)
      this.limiter.connect(context.destination)
    }
    if (context.state === 'suspended') void context.resume()
    const samples = decodeFloat32(message.pcmBase64)
    if (samples.length === 0) return
    const buffer = context.createBuffer(1, samples.length, message.sampleRate)
    buffer.getChannelData(0).set(samples)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain)
    const startAt = Math.max(context.currentTime + 0.025, this.nextStartAt)
    this.nextStartAt = startAt + buffer.duration
    this.sources.add(source)
    source.onended = () => this.sources.delete(source)
    source.start(startAt)
  }

  cancel(speechId?: string): void {
    for (const source of this.sources) {
      try { source.stop() } catch { /* already stopped */ }
    }
    this.sources.clear()
    this.noteCancelledSpeech(speechId ?? this.speechId)
    this.speechId = undefined
    this.lastSequenceBySpeech.clear()
    this.nextStartAt = this.context?.currentTime ?? 0
  }

  private noteCancelledSpeech(speechId: string | undefined): void {
    if (!speechId) return
    const now = Date.now()
    for (const [candidate, at] of this.cancelledSpeechAt) {
      if (now - at > VoiceAudioPlayer.CANCELLED_SPEECH_TTL_MS) this.cancelledSpeechAt.delete(candidate)
    }
    this.cancelledSpeechAt.set(speechId, now)
    if (this.cancelledSpeechAt.size > 64) {
      const oldest = this.cancelledSpeechAt.keys().next().value
      if (oldest !== undefined) this.cancelledSpeechAt.delete(oldest)
    }
  }

  private isCancelledSpeech(speechId: string): boolean {
    const at = this.cancelledSpeechAt.get(speechId)
    if (at === undefined) return false
    if (Date.now() - at > VoiceAudioPlayer.CANCELLED_SPEECH_TTL_MS) {
      this.cancelledSpeechAt.delete(speechId)
      return false
    }
    return true
  }
}

export class LiveVoiceController {
  private state: VoiceUiState = { phase: 'idle', muted: false, ttsBackend: 'kokoro' }
  private readonly clientId = globalThis.crypto.randomUUID()
  private readonly listeners = new Set<Listener>()
  private eventSource: EventSource | undefined
  private session: SessionFace | undefined
  private planner: ResponseSpeechPlanner | undefined
  private latestConversation: VoiceConversationSnapshot | undefined
  private readonly audio = new VoiceAudioPlayer()
  private submitGeneration = 0
  private orphanTimer: number | undefined
  private currentUserText = ''
  private leaseId: string | undefined
  private ownedSessionId: string | undefined
  private panelWorking = false
  private readonly submittedUtterances = new Set<string>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    if (this.orphanTimer !== undefined) window.clearTimeout(this.orphanTimer)
    this.orphanTimer = undefined
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.state.activeSessionId) {
        this.orphanTimer = window.setTimeout(() => {
          if (this.listeners.size === 0) void this.stop()
        }, 250)
      }
    }
  }

  getSnapshot = (): VoiceUiState => this.state

  connect(): void {
    if (!this.eventSource) this.ensureEvents()
  }

  async start(session: SessionFace, initialSnapshot: VoiceConversationSnapshot): Promise<void> {
    if (this.leaseId && this.ownedSessionId === String(session.sessionId)) return
    // WebKit permits audio when the context is opened synchronously from the
    // user's click. Native-hosted Harness uses AVAudioEngine, while this keeps
    // ordinary browser installs audible as a fallback.
    if (!hasNativeVoiceHost()) this.audio.unlock()
    if (this.leaseId) await this.stop()
    const leaseId = globalThis.crypto.randomUUID()
    this.leaseId = leaseId
    this.ownedSessionId = String(session.sessionId)
    this.submittedUtterances.clear()
    this.session = session
    this.latestConversation = initialSnapshot
    if (!this.eventSource) this.ensureEvents()
    const planner = new ResponseSpeechPlanner(
      (text, options) => {
        const spoken = spokenVoiceSummaryText(text)
        if (spoken) this.commandQuietly({
          command: 'speak',
          text: spoken,
          kind: 'response',
          ...(options?.clientTag ? { clientTag: options.clientTag } : {}),
          ...(options?.summaryHandoff ? { summaryHandoff: true } : {}),
        })
      },
      () => undefined,
      (request) => this.requestSpeechSummary(request),
      true,
      () => this.commandQuietly({ command: 'cancel' }),
    )
    this.planner = planner
    planner.reset(initialSnapshot)
    this.panelWorking = initialSnapshot.running
    this.setState({ phase: 'starting', activeSessionId: String(session.sessionId), ownedSessionId: String(session.sessionId), muted: false, ttsBackend: this.state.ttsBackend })
    try {
      await this.command({ command: 'start', sessionId: session.sessionId, leaseId })
    } catch (error) {
      this.releaseLocalOwnership()
      this.setState({
        phase: 'error',
        muted: false,
        ttsBackend: this.state.ttsBackend,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  updateConversation(sessionId: string, snapshot: VoiceConversationSnapshot): void {
    if (this.ownedSessionId !== sessionId || !this.planner) return
    this.latestConversation = snapshot
    this.planner.update(snapshot)
    if (snapshot.running !== this.panelWorking) {
      this.panelWorking = snapshot.running
      this.publishPanelState()
    }
  }

  async stop(): Promise<void> {
    if (!this.leaseId) return
    this.submitGeneration += 1
    this.audio.cancel()
    try {
      await this.command({ command: 'stop' })
    } catch {
      // Local teardown remains authoritative even if the Host has already gone.
    }
    this.releaseLocalOwnership()
    this.setState({ phase: 'idle', muted: false, ttsBackend: this.state.ttsBackend })
  }

  async toggleMuted(): Promise<void> {
    if (!this.leaseId || !this.state.activeSessionId) return
    const muted = !this.state.muted
    try {
      await this.command({ command: 'mute', muted })
      this.setState({ ...this.state, phase: muted ? 'muted' : 'listening', muted })
    } catch (error) {
      this.showCommandError(error)
    }
  }

  async setTtsBackend(ttsBackend: VoiceTtsBackend): Promise<void> {
    if (this.state.activeSessionId || ttsBackend === this.state.ttsBackend) return
    try {
      await this.command({ command: 'set-tts-backend', ttsBackend })
    } catch (error) {
      this.showCommandError(error)
    }
  }

  private ensureEvents(): void {
    this.eventSource?.close()
    const parameters = new URLSearchParams({ clientId: this.clientId })
    if (hasNativeVoiceHost()) parameters.set('playback', 'native')
    const source = new EventSource(`${EVENTS_PATH}?${parameters}`, { withCredentials: true })
    this.eventSource = source
    source.onmessage = (event) => {
      let message: RuntimeMessage
      try {
        const value: unknown = JSON.parse(event.data)
        if (typeof value !== 'object' || value === null || Array.isArray(value)) return
        message = value as RuntimeMessage
      } catch {
        return
      }
      this.handleRuntimeMessage(message)
    }
    source.onerror = () => {
      if (this.state.activeSessionId) this.setState({ ...this.state, phase: 'error', message: 'The local Live Voice connection was interrupted.' })
    }
  }

  private handleRuntimeMessage(message: RuntimeMessage): void {
    switch (message.event) {
      case 'config':
        if (message.ttsBackend === 'kokoro' || message.ttsBackend === 'pocket') {
          this.setState({ ...this.state, ttsBackend: message.ttsBackend })
        }
        break
      case 'state': {
        if (typeof message.phase !== 'string' || !isVoicePhase(message.phase)) break
        const activeSessionId = typeof message.sessionId === 'string' ? message.sessionId : this.state.activeSessionId
        if (message.active === false && this.leaseId) this.releaseLocalOwnership()
        this.setState({
          phase: message.phase,
          ...(message.active === false ? {} : activeSessionId ? { activeSessionId } : {}),
          ...(this.ownedSessionId ? { ownedSessionId: this.ownedSessionId } : {}),
          muted: message.muted === true,
          ttsBackend: this.state.ttsBackend,
          ...(typeof message.message === 'string' ? { message: message.message } : {}),
        })
        break
      }
      case 'ownership-revoked':
        if (typeof message.leaseId === 'string' && message.leaseId === this.leaseId) {
          this.releaseLocalOwnership()
          this.setState(withoutOwnedSession(this.state))
        }
        break
      case 'partial':
        if (!this.ownsInputEvent(message)) break
        this.planner?.cancelSummary()
        this.audio.cancel()
        if (this.state.activeSessionId) this.setState({ ...this.state, phase: 'hearing' })
        break
      case 'final':
        if (this.ownsInputEvent(message) && typeof message.text === 'string' && typeof message.utteranceId === 'string') {
          void this.submitTranscript(message.text, message.utteranceId)
        }
        break
      case 'audio':
        if (hasNativeVoiceHost()) postNativeVoiceMessage({ type: 'audio', ...message })
        // Every Harness page observes runtime state, but only the page that
        // actually started Live Voice may own browser playback.
        else if (this.leaseId) this.audio.play(message)
        break
      case 'audio-done':
        if (hasNativeVoiceHost() && typeof message.speechId === 'string') {
          postNativeVoiceMessage({ type: 'audio-done', speechId: message.speechId })
        }
        break
      case 'speech-started':
        if (typeof message.clientTag === 'string') this.planner?.handleSpeechStarted(message.clientTag)
        break
      case 'audio-cancel':
        if (hasNativeVoiceHost()) postNativeVoiceMessage({ type: 'audio-cancel', ...(typeof message.speechId === 'string' ? { speechId: message.speechId } : {}) })
        else this.audio.cancel(typeof message.speechId === 'string' ? message.speechId : undefined)
        break
      case 'summary-delta':
        if (typeof message.summaryId === 'string' && typeof message.text === 'string') {
          this.planner?.handleSummaryDelta(message.summaryId, message.text)
        }
        break
      case 'summary-done':
        if (typeof message.summaryId === 'string') this.planner?.finishSummary(message.summaryId, message.ok === true)
        break
      case 'holding-ready':
        if (typeof message.requestId === 'string' && typeof message.text === 'string' && validateHoldingPhrase(message.text)) {
          this.commandQuietly({ command: 'accept-holding', requestId: message.requestId })
        }
        break
      default:
        break
    }
  }

  private async submitTranscript(text: string, utteranceId: string): Promise<void> {
    const session = this.session
    if (!session || !text.trim() || this.submittedUtterances.has(utteranceId)) return
    this.submittedUtterances.add(utteranceId)
    if (this.submittedUtterances.size > 256) {
      const oldest = this.submittedUtterances.values().next().value
      if (oldest !== undefined) this.submittedUtterances.delete(oldest)
    }
    this.currentUserText = text.trim()
    const generation = ++this.submitGeneration
    // A new user utterance while the host is idle must not let the previous
    // turn's queued summary/audio tail keep playing over the new response.
    // Steer mode (agent still running) is untouched; its own handoff logic
    // replaces stale response speech.
    const lifecycle = session.getSnapshot()
    if (!lifecycle.running) this.commandQuietly({ command: 'cancel' })
    if (this.latestConversation) this.planner?.reset(this.latestConversation)
    this.commandQuietly({
      command: 'holding',
      requestId: `utterance-${utteranceId}`,
      userText: text.trim().slice(0, 4_000),
      activity: 'responding',
    })
    const mode = lifecycle.running ? 'steer' : 'queue'
    let result: Awaited<ReturnType<SessionFace['prompt']>>
    try {
      result = await session.prompt([{ type: 'text', text: text.trim() }], mode)
    } catch (error) {
      if (generation === this.submitGeneration) this.showCommandError(error)
      return
    }
    if (generation !== this.submitGeneration) return
    if (!result.ok) {
      this.setState({ ...this.state, phase: 'error', message: result.error.message })
      this.commandQuietly({ command: 'speak', text: 'I couldn’t send that. The error is shown in the chat.', kind: 'system', replace: true })
    }
  }

  private requestSpeechSummary(request: SpeechSummaryRequest): void {
    void this.command({
      command: 'summarize',
      ...request,
      userText: spokenVoiceSummaryText(this.currentUserText).slice(0, 4_000),
    }).catch(() => this.planner?.finishSummary(request.summaryId, false))
  }

  private commandQuietly(body: RuntimeMessage): void {
    void this.command(body).catch((error: unknown) => this.showCommandError(error))
  }

  private showCommandError(error: unknown): void {
    if (!this.state.activeSessionId) return
    this.setState({
      ...this.state,
      phase: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  private async command(body: RuntimeMessage): Promise<void> {
    const payload = {
      clientId: this.clientId,
      ...(this.leaseId ? { leaseId: this.leaseId } : {}),
      ...body,
    }
    const response = await fetch(COMMAND_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    })
    if (response.ok) return
    const value: unknown = await response.json().catch(() => undefined)
    const message = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
      ? value.error
      : `Live Voice request failed (${response.status}).`
    throw new Error(message)
  }

  private setState(state: VoiceUiState): void {
    this.state = state
    this.publishPanelState()
    for (const listener of this.listeners) listener()
  }

  private publishPanelState(): void {
    const panelState = {
      type: 'state',
      phase: this.state.phase,
      active: this.state.ownedSessionId !== undefined,
      muted: this.state.muted,
      working: this.panelWorking,
      ...(this.state.message ? { message: this.state.message } : {}),
    }
    postNativeVoiceMessage(panelState)
    postFloatingVoicePanelState({
      ...panelState,
      clientId: this.clientId,
      ...(this.leaseId ? { leaseId: this.leaseId } : {}),
    })
  }

  private ownsInputEvent(message: RuntimeMessage): boolean {
    return Boolean(this.leaseId
      && this.ownedSessionId
      && message.clientId === this.clientId
      && message.leaseId === this.leaseId
      && message.sessionId === this.ownedSessionId
      && typeof message.utteranceId === 'string')
  }

  private releaseLocalOwnership(): void {
    this.submitGeneration += 1
    this.planner?.dispose()
    this.planner = undefined
    this.latestConversation = undefined
    this.session = undefined
    this.currentUserText = ''
    this.leaseId = undefined
    this.ownedSessionId = undefined
    this.panelWorking = false
    this.submittedUtterances.clear()
  }
}

export const liveVoiceController = new LiveVoiceController()

function decodeFloat32(base64: string): Float32Array {
  const binary = window.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Float32Array(bytes.buffer)
}

function isVoicePhase(value: string): value is VoiceUiPhase {
  return ['idle', 'starting', 'listening', 'hearing', 'thinking', 'speaking', 'muted', 'error'].includes(value)
}

function withoutOwnedSession(state: VoiceUiState): VoiceUiState {
  const { ownedSessionId: _ownedSessionId, ...rest } = state
  return rest
}
