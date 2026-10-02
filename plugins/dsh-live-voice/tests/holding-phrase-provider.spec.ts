import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HoldingDiagnosticEvent, HoldingFallbackReason } from '../src/holding-diagnostics.ts'
import {
  HoldingPhraseScheduler,
  LocalMlxHoldingPhraseProvider,
  resolveHoldingPhraseDelay,
  resolveHoldingPhraseProvider,
} from '../src/holding-phrase-provider.ts'
import { inspectHoldingPhrase, sanitizeHoldingContext, validateHoldingPhrase } from '../src/shared/holding-phrase.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('contextual holding phrases', () => {
  it('uses minimal sanitized context and a neutral activity with the local backend', async () => {
    const backend = fakeBackend('Let me review that carefully.')
    const provider = new LocalMlxHoldingPhraseProvider(backend as never)
    const result = await provider.generate(request({
      userText: 'Review `/Users/example/Secret Plan.md` at https://private.example and explain it.',
      activity: 'reviewing',
    }), new AbortController().signal)

    expect(result).toEqual({ text: 'Let me review that carefully.', source: 'local-mlx' })
    expect(backend.generatePrompt).toHaveBeenCalledTimes(1)
    const prompt = backend.generatePrompt.mock.calls[0]![0].prompt
    expect(prompt).toContain('Neutral activity: reviewing.')
    expect(prompt).not.toContain('/Users/example')
    expect(prompt).not.toContain('private.example')
    expect(prompt).not.toContain('Secret Plan')
    expect(prompt).toContain('do not repeat the context')
  })

  it('enforces 4–14 safe spoken words and rejects answer prediction or commitments', () => {
    expect(validateHoldingPhrase('Let me check that carefully.')).toBe('Let me check that carefully.')
    expect(validateHoldingPhrase('Let me review those details carefully and think through those options.')).toBe(
      'Let me review those details carefully and think through those options.',
    )
    expect(validateHoldingPhrase('Checking now.')).toBeUndefined()
    expect(validateHoldingPhrase('Let me check that carefully while I review those details and consider all those options closely.')).toBeUndefined()
    expect(validateHoldingPhrase('The answer is ready now.')).toBeUndefined()
    expect(validateHoldingPhrase('I will fix that.')).toBeUndefined()
    expect(validateHoldingPhrase('Let me open /Users/example/secret.txt.')).toBeUndefined()
  })

  it('accepts topic-aware process phrases without a global word allowlist', () => {
    expect(inspectHoldingPhrase("I'm comparing those model-routing trade-offs.")).toEqual({
      ok: true,
      text: "I'm comparing those model-routing trade-offs.",
    })
    expect(inspectHoldingPhrase('Let me examine the voice timing issue.')).toEqual({
      ok: true,
      text: 'Let me examine the voice timing issue.',
    })
    expect(inspectHoldingPhrase("I'm tracing why those phrases sound repetitive.")).toEqual({
      ok: true,
      text: "I'm tracing why those phrases sound repetitive.",
    })
  })

  it('reports structural and intent-level rejection reasons', () => {
    expect(inspectHoldingPhrase('')).toEqual({ ok: false, reason: 'empty' })
    expect(inspectHoldingPhrase('Let me review /tmp/item.')).toEqual({ ok: false, reason: 'forbidden-format' })
    expect(inspectHoldingPhrase("I'm checking app.ts behavior.")).toEqual({ ok: false, reason: 'forbidden-format' })
    expect(inspectHoldingPhrase('The answer is correct.')).toEqual({ ok: false, reason: 'unsafe-language' })
    expect(inspectHoldingPhrase("I'll compare those options.")).toEqual({ ok: false, reason: 'unsafe-language' })
    expect(inspectHoldingPhrase("I'm reviewing this, then comparing it.")).toEqual({ ok: false, reason: 'punctuation' })
    expect(inspectHoldingPhrase("I'm checking this. I'm reviewing that.")).toEqual({ ok: false, reason: 'punctuation' })
    expect(inspectHoldingPhrase('Checking.')).toEqual({ ok: false, reason: 'word-count' })
    expect(inspectHoldingPhrase('This topic needs more careful detail.')).toEqual({ ok: false, reason: 'missing-process-verb' })
  })

  it('requests specific varied wording without priming the generic example', async () => {
    const backend = fakeBackend("I'm examining the voice timing issue.")
    const provider = new LocalMlxHoldingPhraseProvider(backend as never)

    await provider.generate(request({ userText: 'Examine the voice timing issue.', activity: 'reviewing' }), new AbortController().signal)

    const generated = backend.generatePrompt.mock.calls[0]![0]
    expect(generated.system).toContain('specific subject of the request')
    expect(generated.system).toContain('4 to 14 spoken words')
    expect(generated.system).not.toContain('Let me check that carefully')
    expect(generated.maxTokens).toBe(24)
  })

  it('guides the model away from only the four most recent distinct accepted phrases', async () => {
    const backend = sequentialBackend([
      "I'm checking the alpha options.",
      "I'm reviewing the beta approach.",
      "I'm comparing the gamma trade-offs.",
      "I'm tracing the delta timing.",
      "I'm assessing the epsilon behavior.",
      "I'm examining the zeta details.",
    ])
    const provider = new LocalMlxHoldingPhraseProvider(backend as never)

    for (let index = 0; index < 6; index += 1) {
      await provider.generate(request({ userText: `Review topic ${index}.`, activity: 'reviewing' }), new AbortController().signal)
    }

    const sixthPrompt = backend.generatePrompt.mock.calls[5]![0].prompt
    expect(sixthPrompt).not.toContain("I'm checking the alpha options.")
    expect(sixthPrompt).toContain("I'm reviewing the beta approach.")
    expect(sixthPrompt).toContain("I'm comparing the gamma trade-offs.")
    expect(sixthPrompt).toContain("I'm tracing the delta timing.")
    expect(sixthPrompt).toContain("I'm assessing the epsilon behavior.")
  })

  it('falls back without generation while the shared model is cold or output is invalid', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const cold = fakeBackend('Let me review that carefully.', 'cold')
    const coldProvider = new LocalMlxHoldingPhraseProvider(cold as never)
    await expect(coldProvider.generate(request({ userText: 'Please inspect this.', activity: 'reviewing' }), new AbortController().signal)).resolves.toMatchObject({
      text: 'Let me review that carefully.',
      source: 'canned',
      fallbackReason: 'backend-not-ready',
    })
    expect(cold.generatePrompt).not.toHaveBeenCalled()

    const invalid = fakeBackend('The answer is definitely correct.')
    const invalidProvider = new LocalMlxHoldingPhraseProvider(invalid as never)
    await expect(invalidProvider.generate(request({ userText: 'Please inspect this.', activity: 'reviewing' }), new AbortController().signal)).resolves.toMatchObject({ source: 'canned' })
  })

  it('records rejected local output without recording request context', async () => {
    const events: HoldingDiagnosticEvent[] = []
    const backend = fakeBackend('The answer is definitely correct.')
    const provider = new LocalMlxHoldingPhraseProvider(backend as never, { record: (event) => events.push(event) })
    const result = await provider.generate(request({ userText: 'Private request details', activity: 'responding' }), new AbortController().signal)

    expect(result).toMatchObject({ source: 'canned', fallbackReason: 'invalid-output' })
    expect(events).toContainEqual(expect.objectContaining({
      event: 'generation',
      backendState: 'ready',
      outcome: 'completed',
      rawPhrase: 'The answer is definitely correct.',
      validation: { ok: false, reason: 'unsafe-language' },
    }))
    expect(JSON.stringify(events)).not.toContain('Private request details')
  })

  it('records a deadline selection separately from local generation', async () => {
    vi.useFakeTimers()
    const events: HoldingDiagnosticEvent[] = []
    const provider = fakeProvider(undefined, true)
    const scheduler = new HoldingPhraseScheduler(provider, 550, { record: (event) => events.push(event) })
    const play = vi.fn()
    scheduler.start(request({}), play)
    await vi.advanceTimersByTimeAsync(550)

    expect(events).toContainEqual(expect.objectContaining({
      event: 'selection',
      source: 'canned',
      reason: 'deadline',
      elapsedMs: 550,
    }))
  })

  it('plays one ready phrase only after the threshold', async () => {
    vi.useFakeTimers()
    const provider = fakeProvider({ text: 'Let me check that carefully.', source: 'local-mlx' })
    const scheduler = new HoldingPhraseScheduler(provider, 550)
    const play = vi.fn()
    scheduler.start(request({}), play)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(549)
    expect(play).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(play).toHaveBeenCalledOnce()
    expect(play).toHaveBeenCalledWith({ text: 'Let me check that carefully.', source: 'local-mlx' })
  })

  it('cancels immediately when response audio wins the race', async () => {
    vi.useFakeTimers()
    const provider = fakeProvider({ text: 'Let me check that carefully.', source: 'local-mlx' })
    const scheduler = new HoldingPhraseScheduler(provider, 550)
    const play = vi.fn()
    scheduler.start(request({}), play)
    scheduler.cancel()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(play).not.toHaveBeenCalled()
    expect(provider.signal?.aborted).toBe(true)
  })

  it('uses the canned fallback exactly once when local generation is late', async () => {
    vi.useFakeTimers()
    const provider = fakeProvider(undefined, true)
    const scheduler = new HoldingPhraseScheduler(provider, 550)
    const play = vi.fn()
    scheduler.start(request({}), play)
    await vi.advanceTimersByTimeAsync(550)
    expect(play).toHaveBeenCalledOnce()
    expect(play).toHaveBeenCalledWith({
      text: 'Let me check that carefully.',
      source: 'canned',
      fallbackReason: 'deadline',
    })
    expect(provider.signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(play).toHaveBeenCalledOnce()
  })

  it('keeps provider selection and delay independently configurable', () => {
    expect(resolveHoldingPhraseProvider(undefined)).toBe('local-mlx')
    expect(resolveHoldingPhraseProvider(' canned ')).toBe('canned')
    expect(() => resolveHoldingPhraseProvider('remote')).toThrow('Unsupported')
    expect(resolveHoldingPhraseDelay({})).toBe(550)
    expect(resolveHoldingPhraseDelay({ holdingPhraseDelayMs: 900 })).toBe(900)
    expect(resolveHoldingPhraseDelay({ holdingPhraseDelayMs: 10 })).toBe(250)
    expect(resolveHoldingPhraseDelay({ acknowledgementDelayMs: 900 })).toBe(900)
    expect(resolveHoldingPhraseDelay({ acknowledgementDelayMs: 100 })).toBe(550)
  })

  it('sanitizes machine artifacts before any provider sees context', () => {
    const context = sanitizeHoldingContext('↓ Check `secret()` in /tmp/private.txt at https://example.com now.')
    expect(context).not.toMatch(/↓|secret|\/tmp|https|example/u)
  })
})

function request(overrides: Partial<{ userText: string; activity: 'responding' | 'checking' | 'reviewing' | 'working' }> = {}) {
  return {
    requestId: 'holding-1',
    userText: overrides.userText ?? 'Please check this carefully.',
    activity: overrides.activity ?? 'checking',
  }
}

function fakeBackend(output: string, state: 'ready' | 'cold' = 'ready') {
  return {
    status: vi.fn(() => ({ kind: 'local-mlx', state })),
    warm: vi.fn(async () => undefined),
    release: vi.fn(),
    generatePrompt: vi.fn(async (_request, onDelta: (text: string) => void) => {
      onDelta(output)
      return true
    }),
  }
}

function sequentialBackend(outputs: string[]) {
  let index = 0
  return {
    status: vi.fn(() => ({ kind: 'local-mlx', state: 'ready' as const })),
    warm: vi.fn(async () => undefined),
    release: vi.fn(),
    generatePrompt: vi.fn(async (_request, onDelta: (text: string) => void) => {
      onDelta(outputs[index++]!)
      return true
    }),
  }
}

function fakeProvider(
  result?: { text: string; source: 'local-mlx' | 'canned'; fallbackReason?: HoldingFallbackReason },
  neverResolve = false,
) {
  const provider = {
    kind: 'local-mlx' as const,
    signal: undefined as AbortSignal | undefined,
    warm: vi.fn(async () => undefined),
    release: vi.fn(),
    fallback: vi.fn((_request, reason?: HoldingFallbackReason) => ({
      text: 'Let me check that carefully.',
      source: 'canned' as const,
      ...(reason ? { fallbackReason: reason } : {}),
    })),
    generate: vi.fn((_request, signal: AbortSignal) => {
      provider.signal = signal
      return neverResolve ? new Promise<never>(() => {}) : Promise.resolve(result!)
    }),
  }
  return provider
}
