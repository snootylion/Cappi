import { randomUUID } from 'node:crypto'
import {
  NOOP_HOLDING_DIAGNOSTICS,
  type HoldingDiagnosticSink,
  type HoldingFallbackReason,
} from './holding-diagnostics.ts'
import { selectHoldingStatement } from './shared/holding-statements.ts'
import { inspectHoldingPhrase, sanitizeHoldingContext, validateHoldingPhrase } from './shared/holding-phrase.ts'
import type { LocalMlxSummaryBackend } from './summary-backends.ts'
import type { VoicePluginConfig } from './runtime.ts'
import { DEFAULT_VOICE_DEFAULTS } from './voice-defaults.ts'

export type HoldingPhraseProviderKind = 'local-mlx' | 'canned'
export type HoldingActivity = 'responding' | 'checking' | 'reviewing' | 'working'

export interface HoldingPhraseRequest {
  readonly requestId: string
  readonly userText: string
  readonly activity: HoldingActivity
}

export interface HoldingPhraseResult {
  readonly text: string
  readonly source: 'local-mlx' | 'canned'
  readonly fallbackReason?: HoldingFallbackReason
}

export interface HoldingPhraseProvider {
  readonly kind: HoldingPhraseProviderKind
  warm(): Promise<void>
  release(): void
  generate(request: HoldingPhraseRequest, signal: AbortSignal): Promise<HoldingPhraseResult>
  fallback(request: HoldingPhraseRequest, reason?: HoldingFallbackReason): HoldingPhraseResult
}

export const DEFAULT_HOLDING_PHRASE_PROVIDER: HoldingPhraseProviderKind = DEFAULT_VOICE_DEFAULTS.holdingPhraseProvider
export const DEFAULT_HOLDING_PHRASE_DELAY_MS = DEFAULT_VOICE_DEFAULTS.holdingPhraseDelayMs

const HOLDING_SYSTEM_PROMPT = `Write one brief, varied holding phrase for live speech while an answer is being prepared. Mention the specific subject of the request in natural language and describe only the act of checking, reviewing, comparing, examining, tracing, assessing, considering, exploring, weighing, thinking through, looking into, or working through it. Use exactly one clause of 4 to 14 spoken words. Do not answer, conclude, agree, guarantee, promise, claim completion, state a result, or mention paths, URLs, code, Markdown, machine identifiers, symbols, or timing. Return only the words to speak.`

export class LocalMlxHoldingPhraseProvider implements HoldingPhraseProvider {
  readonly kind = 'local-mlx' as const
  private readonly recentPhrases: string[] = []

  constructor(
    private readonly backend: LocalMlxSummaryBackend,
    private readonly diagnostics: HoldingDiagnosticSink = NOOP_HOLDING_DIAGNOSTICS,
  ) {}

  warm(): Promise<void> {
    return this.backend.warm()
  }

  release(): void {
    this.backend.release()
  }

  async generate(request: HoldingPhraseRequest, signal: AbortSignal): Promise<HoldingPhraseResult> {
    const startedAt = Date.now()
    const backendState = this.backend.status().state
    if (signal.aborted) {
      this.diagnostics.record({ event: 'generation', requestId: request.requestId, backendState, outcome: 'aborted', completionMs: 0 })
      return this.fallback(request)
    }
    if (backendState !== 'ready') {
      this.diagnostics.record({ event: 'generation', requestId: request.requestId, backendState, outcome: 'skipped', completionMs: Date.now() - startedAt })
      return this.fallback(request, 'backend-not-ready')
    }
    const context = sanitizeHoldingContext(request.userText)
    if (!context) {
      this.diagnostics.record({ event: 'generation', requestId: request.requestId, backendState, outcome: 'skipped', completionMs: Date.now() - startedAt })
      return this.fallback(request, 'empty-context')
    }

    let raw = ''
    let firstDeltaMs: number | undefined
    let ok = false
    try {
      ok = await this.backend.generatePrompt({
        requestId: `holding-${request.requestId || randomUUID()}`,
        system: HOLDING_SYSTEM_PROMPT,
        prompt: [
          `Neutral activity: ${request.activity}.`,
          `Sanitized request context: ${context}`,
          'Return only a safe holding phrase; do not repeat the context verbatim.',
          ...(this.recentPhrases.length > 0
            ? [`Avoid repeating these recent phrases:\n${this.recentPhrases.map((phrase) => `- ${phrase}`).join('\n')}`]
            : []),
        ].join('\n'),
        maxTokens: 24,
      }, (delta) => {
        if (firstDeltaMs === undefined && delta) firstDeltaMs = Date.now() - startedAt
        raw += delta
      }, signal)
    } catch {
      this.diagnostics.record({ event: 'generation', requestId: request.requestId, backendState, outcome: 'error', completionMs: Date.now() - startedAt })
      return this.fallback(request, 'generation-error')
    }

    const completionMs = Date.now() - startedAt
    if (signal.aborted) {
      this.diagnostics.record({ event: 'generation', requestId: request.requestId, backendState, outcome: 'aborted', ...(firstDeltaMs === undefined ? {} : { firstDeltaMs }), completionMs, ...(raw ? { rawPhrase: raw } : {}) })
      return this.fallback(request)
    }
    if (!ok) {
      this.diagnostics.record({ event: 'generation', requestId: request.requestId, backendState, outcome: 'error', ...(firstDeltaMs === undefined ? {} : { firstDeltaMs }), completionMs, ...(raw ? { rawPhrase: raw } : {}) })
      return this.fallback(request, 'generation-error')
    }

    const validation = inspectHoldingPhrase(raw)
    this.diagnostics.record({ event: 'generation', requestId: request.requestId, backendState, outcome: 'completed', ...(firstDeltaMs === undefined ? {} : { firstDeltaMs }), completionMs, rawPhrase: raw, validation })
    if (!validation.ok) return this.fallback(request, 'invalid-output')
    this.rememberPhrase(validation.text)
    return { text: validation.text, source: 'local-mlx' }
  }

  private rememberPhrase(text: string): void {
    const key = text.toLocaleLowerCase().replace(/[.!?]+$/u, '').trim()
    const duplicate = this.recentPhrases.findIndex((phrase) => (
      phrase.toLocaleLowerCase().replace(/[.!?]+$/u, '').trim() === key
    ))
    if (duplicate >= 0) this.recentPhrases.splice(duplicate, 1)
    this.recentPhrases.push(text)
    if (this.recentPhrases.length > 4) this.recentPhrases.splice(0, this.recentPhrases.length - 4)
  }

  fallback(request: HoldingPhraseRequest, reason?: HoldingFallbackReason): HoldingPhraseResult {
    const selected = selectHoldingStatement(request.userText)
    const text = selected.speak ? validateHoldingPhrase(selected.text) : undefined
    return {
      text: text ?? 'Let me check that carefully.',
      source: 'canned',
      ...(reason ? { fallbackReason: reason } : {}),
    }
  }
}

export class CannedHoldingPhraseProvider implements HoldingPhraseProvider {
  readonly kind = 'canned' as const

  async warm(): Promise<void> {}
  release(): void {}

  async generate(request: HoldingPhraseRequest, _signal: AbortSignal): Promise<HoldingPhraseResult> {
    return this.fallback(request, 'configured-canned')
  }

  fallback(request: HoldingPhraseRequest, reason: HoldingFallbackReason = 'configured-canned'): HoldingPhraseResult {
    const selected = selectHoldingStatement(request.userText)
    const text = selected.speak ? validateHoldingPhrase(selected.text) : undefined
    return { text: text ?? 'Let me check that carefully.', source: 'canned', fallbackReason: reason }
  }
}

export class HoldingPhraseScheduler {
  private task: { readonly controller: AbortController; readonly timer: NodeJS.Timeout } | undefined
  private delayMs: number

  constructor(
    private readonly provider: HoldingPhraseProvider,
    delayMs: number,
    private readonly diagnostics: HoldingDiagnosticSink = NOOP_HOLDING_DIAGNOSTICS,
  ) {
    this.delayMs = delayMs
  }

  start(request: HoldingPhraseRequest, play: (result: HoldingPhraseResult) => void): void {
    this.cancel()
    const startedAt = Date.now()
    const controller = new AbortController()
    let result: HoldingPhraseResult | undefined
    this.diagnostics.record({ event: 'request', requestId: request.requestId, deadlineMs: this.delayMs })
    const timer = setTimeout(() => {
      if (this.task?.controller !== controller || controller.signal.aborted) return
      this.task = undefined
      if (!result) controller.abort()
      const selected = result ?? this.provider.fallback(request, 'deadline')
      this.diagnostics.record({
        event: 'selection',
        requestId: request.requestId,
        source: selected.source,
        ...(selected.fallbackReason ? { reason: selected.fallbackReason } : {}),
        phrase: selected.text,
        elapsedMs: Date.now() - startedAt,
      })
      play(selected)
    }, this.delayMs)
    timer.unref()
    this.task = { controller, timer }
    void this.provider.generate(request, controller.signal).then((value) => {
      if (this.task?.controller === controller && !controller.signal.aborted) result = value
    }).catch(() => {
      if (this.task?.controller === controller && !controller.signal.aborted) {
        result = this.provider.fallback(request, 'generation-error')
      }
    })
  }

  setDelay(delayMs: number): void {
    this.delayMs = Math.min(1_500, Math.max(250, Math.round(delayMs)))
  }

  cancel(): void {
    const task = this.task
    this.task = undefined
    if (!task) return
    clearTimeout(task.timer)
    task.controller.abort()
  }
}

export function resolveHoldingPhraseProvider(value: string | undefined): HoldingPhraseProviderKind {
  const normalized = value?.trim()
  if (!normalized || normalized === 'local-mlx') return 'local-mlx'
  if (normalized === 'canned') return 'canned'
  throw new Error(`Unsupported holding phrase provider: ${normalized}`)
}

export function resolveHoldingPhraseDelay(config: VoicePluginConfig): number {
  const value = config.holdingPhraseDelayMs ?? (typeof config.acknowledgementDelayMs === 'number'
    ? Math.max(DEFAULT_HOLDING_PHRASE_DELAY_MS, config.acknowledgementDelayMs)
    : undefined)
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1_500, Math.max(250, value))
    : DEFAULT_HOLDING_PHRASE_DELAY_MS
}

export { sanitizeHoldingContext, validateHoldingPhrase } from './shared/holding-phrase.ts'
