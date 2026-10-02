import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectHoldingStatement } from '../src/shared/holding-statements.ts'
import { extractCompletedVoiceSentences, spokenVoiceSummaryText, spokenVoiceText, stripStreamingVoiceCode } from '../src/shared/voice-text.ts'
import { VOICE_SUMMARY_SYSTEM_PROMPT } from '../src/summary-backends.ts'
import {
  buildVoiceSummaryPrompt,
  createVoiceSummaryBackend,
  createVoiceSummaryGenerator,
  DEFAULT_VOICE_SUMMARY_MODEL,
  DEFAULT_VOICE_SUMMARY_PROVIDER,
  resolveVoiceSummaryRoute,
} from '../src/index.ts'

afterEach(() => vi.restoreAllMocks())

describe('ported Pi Live Voice behavior', () => {
  it('strips code, URLs, paths, and Markdown from speech', () => {
    const result = spokenVoiceText('**Done.** See `secret()` at https://example.com and `/tmp/private.txt`.')
    expect(result).toBe('Done. See at and.')
  })

  it('streams only completed sentences and retains the unfinished tail', () => {
    expect(extractCompletedVoiceSentences('First answer. Second is still')).toEqual({
      sentences: ['First answer.'],
      remainder: ' Second is still',
    })
  })

  it('removes screen-reader glyph names and wrapped machine paths from summaries', () => {
    expect(spokenVoiceSummaryText('↓ Updated "/Users/example/project/controller.ts". Next → restart the app.')).toBe('Updated. Next restart the app.')
    expect(spokenVoiceSummaryText('Down arrow: open (~/Library/Application Support/Pi Agent/settings.json).')).toBe('open.')
  })

  it('suppresses fenced diagrams before their closing marker streams in', () => {
    expect(stripStreamingVoiceCode('Result follows.\n```text\nMicrophone\n↓\nApple Speech')).toBe('Result follows.\n')
    expect(stripStreamingVoiceCode('```text\nMicrophone\n↓\nApple Speech\n```\nActual result.')).toBe('\nActual result.')
    expect(stripStreamingVoiceCode('Use `internalMethod()` and continue.')).toBe('Use  and continue.')
  })

  it('keeps holding statements deterministic at the routing boundary', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(selectHoldingStatement('Please inspect these changes')).toEqual({
      speak: true,
      category: 'REVIEW',
      text: 'Let me review that carefully.',
    })
    expect(selectHoldingStatement('Hello, how are you?')).toEqual({ speak: false })
  })

  it('builds a speech-only summary prompt without a transcript marker', () => {
    const prompt = buildVoiceSummaryPrompt({
      summaryId: 'summary-1',
      userText: 'What changed?',
      spokenLead: 'The change is complete.',
      responseText: 'Verification passed. Restart the app.',
    })

    expect(prompt).toContain('Opening already spoken aloud (do not repeat):')
    expect(prompt).toContain('Exact finalized remainder to summarize faithfully:')
    expect(prompt).not.toContain('What changed?')
    expect(prompt).not.toContain('pi-gui-voice-summary')
    expect(VOICE_SUMMARY_SYSTEM_PROMPT).toContain('one to three short sentences')
    expect(VOICE_SUMMARY_SYSTEM_PROMPT).toContain('at most 42 words total')
    expect(VOICE_SUMMARY_SYSTEM_PROMPT).toContain('Use fewer sentences when that is enough')
  })

  it('streams through the supported small model with reasoning explicitly off', async () => {
    const stream = vi.fn(async function* (_options: unknown) {
      yield { type: 'text-delta' as const, index: 0, text: 'Concise result.' }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    })
    const resolveModelInfo = vi.fn().mockResolvedValue({
      provider: DEFAULT_VOICE_SUMMARY_PROVIDER,
      id: DEFAULT_VOICE_SUMMARY_MODEL,
      name: 'GPT-5.4 mini',
      reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'minimal', name: 'Minimal' }] },
    })
    const generate = createVoiceSummaryGenerator({ llm: { resolveModelInfo, stream } } as never)
    const deltas: string[] = []
    const ok = await generate({
      summaryId: 'summary-1',
      userText: 'What changed?',
      spokenLead: 'The change is complete.',
      responseText: 'Verification passed.',
    }, (text) => deltas.push(text), new AbortController().signal)

    expect(ok).toBe(true)
    expect(deltas).toEqual(['Concise result.'])
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      provider: DEFAULT_VOICE_SUMMARY_PROVIDER,
      model: DEFAULT_VOICE_SUMMARY_MODEL,
      reasoningEffort: 'off',
      maxTokens: 160,
    }))
    expect(resolveModelInfo).toHaveBeenCalledWith(
      DEFAULT_VOICE_SUMMARY_PROVIDER,
      DEFAULT_VOICE_SUMMARY_MODEL,
      expect.any(AbortSignal),
    )
    expect(stream.mock.calls[0]![0]).not.toHaveProperty('sessionId')
  })

  it('does not use the former remote model for the default backend', () => {
    const resolveModelInfo = vi.fn()
    const stream = vi.fn()
    const backend = createVoiceSummaryBackend({
      llm: { resolveModelInfo, stream },
      logger: { warn: vi.fn() },
    } as never)

    expect(backend.kind).toBe('local-mlx')
    expect(resolveModelInfo).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
  })

  it('keeps the auxiliary fast route configurable', () => {
    expect(resolveVoiceSummaryRoute({ summaryProvider: ' local-fast ', summaryModel: ' mini-summary ' })).toEqual({
      provider: 'local-fast',
      model: 'mini-summary',
    })
  })
})
