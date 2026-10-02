import { describe, expect, it, vi } from 'vitest'
import { ResponseSpeechPlanner, type SpeechSummaryRequest, type VoiceConversationSnapshot } from '../src/client/controller.ts'

describe('response speech planning', () => {
  it('speaks two final sentences, then uses a streamed hidden summary', () => {
    const spoken: string[] = []
    const summaries: SpeechSummaryRequest[] = []
    const planner = new ResponseSpeechPlanner((text) => spoken.push(text), () => undefined, (request) => summaries.push(request))
    planner.reset(snapshot({ running: false }))

    const answer = 'Opening result. Important context. Detailed evidence. The next action is ready.'
    planner.update(snapshot({ running: true, partialText: answer }))
    expect(spoken).toEqual(['Opening result.', 'Important context.'])

    planner.update(snapshot({ running: false, finalText: answer }))
    expect(spoken).toEqual(['Opening result.', 'Important context.'])
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      responseText: 'Detailed evidence. The next action is ready.',
      spokenLead: 'Opening result. Important context.',
    })

    const summaryId = summaries[0]!.summaryId
    planner.handleSummaryDelta(summaryId, 'The evidence confirms the result. Next, apply the prepared change.')
    planner.finishSummary(summaryId, true)
    expect(spoken).toEqual([
      'Opening result.',
      'Important context.',
      'The evidence confirms the result.',
      'Next, apply the prepared change.',
    ])
  })

  it('hands off before an unstarted second sentence and includes that sentence in the summary source', () => {
    const speech: Array<{ text: string; clientTag?: string; summaryHandoff?: boolean }> = []
    const summaries: SpeechSummaryRequest[] = []
    const planner = new ResponseSpeechPlanner(
      (text, options) => speech.push({ text, ...options }),
      () => undefined,
      (request) => summaries.push(request),
      true,
    )
    planner.reset(snapshot({ running: false }))
    const answer = 'First outcome. Second context. Third detail. Fourth detail.'
    planner.update(snapshot({ running: true, partialText: answer }))
    planner.handleSpeechStarted(speech[0]!.clientTag!)
    planner.update(snapshot({ running: false, finalText: answer }))

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      spokenLead: 'First outcome.',
      responseText: 'Second context. Third detail. Fourth detail.',
    })
    planner.handleSummaryDelta(summaries[0]!.summaryId, 'The context and remaining details are ready.')
    planner.finishSummary(summaries[0]!.summaryId, true)

    expect(speech.at(-1)).toEqual({
      text: 'The context and remaining details are ready.',
      summaryHandoff: true,
    })
  })

  it('does not re-request a summary when a later opening starts mid-generation', () => {
    const speech: Array<{ text: string; clientTag?: string; summaryHandoff?: boolean }> = []
    const summaries: SpeechSummaryRequest[] = []
    const planner = new ResponseSpeechPlanner(
      (text, options) => speech.push({ text, ...options }),
      () => undefined,
      (request) => summaries.push(request),
      true,
    )
    planner.reset(snapshot({ running: false }))
    const answer = 'First outcome. Second context. Third detail. Fourth detail.'
    planner.update(snapshot({ running: true, partialText: answer }))
    planner.handleSpeechStarted(speech[0]!.clientTag!)
    planner.update(snapshot({ running: false, finalText: answer }))
    const firstSummaryId = summaries[0]!.summaryId
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      spokenLead: 'First outcome.',
      responseText: 'Second context. Third detail. Fourth detail.',
    })

    // The second opening begins while the first summary is already pending.
    // This must rebase the fallback boundary, never start a second synthesis.
    planner.handleSpeechStarted(speech[1]!.clientTag!)
    expect(summaries).toHaveLength(1)

    planner.handleSummaryDelta(firstSummaryId, 'Only the remaining details are summarized.')
    planner.finishSummary(firstSummaryId, true)
    expect(speech.at(-1)).toEqual({
      text: 'Only the remaining details are summarized.',
      summaryHandoff: false,
    })
  })

  it('fails open to held visible prose when summary generation fails', () => {
    const spoken: string[] = []
    let request: SpeechSummaryRequest | undefined
    const planner = new ResponseSpeechPlanner((text) => spoken.push(text), () => undefined, (value) => { request = value })
    planner.reset(snapshot({ running: false }))
    const answer = 'First. Second. Third detail. Fourth detail.'
    planner.update(snapshot({ running: true, partialText: answer }))
    planner.update(snapshot({ running: false, finalText: answer }))

    planner.finishSummary(request!.summaryId, false)
    expect(spoken).toEqual(['First.', 'Second.', 'Third detail.', 'Fourth detail.'])
  })

  it('speaks the full summary without a sentence cap', () => {
    const spoken: string[] = []
    let request: SpeechSummaryRequest | undefined
    const planner = new ResponseSpeechPlanner((text) => spoken.push(text), () => undefined, (value) => { request = value })
    planner.reset(snapshot({ running: false }))
    const answer = 'First. Second. Third. Fourth.'
    planner.update(snapshot({ running: true, partialText: answer }))
    planner.update(snapshot({ running: false, finalText: answer }))

    planner.handleSummaryDelta(request!.summaryId, 'Summary one. Summary two. Summary three. Summary four still plays.')
    planner.finishSummary(request!.summaryId, true)

    expect(spoken.slice(2)).toEqual(['Summary one.', 'Summary two.', 'Summary three.', 'Summary four still plays.'])
  })

  it('reads a long summary in full instead of cutting at a word cap', () => {
    const spoken: string[] = []
    let request: SpeechSummaryRequest | undefined
    const planner = new ResponseSpeechPlanner((text) => spoken.push(text), () => undefined, (value) => { request = value })
    planner.reset(snapshot({ running: false }))
    const answer = 'First. Second. Third. Fourth.'
    planner.update(snapshot({ running: true, partialText: answer }))
    planner.update(snapshot({ running: false, finalText: answer }))

    const sentence = Array.from({ length: 20 }, (_, index) => `word${index}`).join(' ')
    planner.handleSummaryDelta(request!.summaryId, `${sentence}. ${sentence}. ${sentence}.`)
    planner.finishSummary(request!.summaryId, true)

    const summarySpeech = spoken.slice(2)
    expect(summarySpeech).toHaveLength(3)
    expect(summarySpeech.join(' ').split(/\s+/u)).toHaveLength(60)
  })

  it('never speaks a streamed arrow diagram before its code fence closes', () => {
    const spoken: string[] = []
    const summaries: SpeechSummaryRequest[] = []
    const planner = new ResponseSpeechPlanner((text) => spoken.push(text), () => undefined, (request) => summaries.push(request))
    planner.reset(snapshot({ running: false }))

    planner.update(snapshot({ running: true, partialText: '```text\nMicrophone\n↓\nApple Speech helper' }))
    expect(spoken).toEqual([])

    const answer = '```text\nMicrophone\n↓\nApple Speech helper\n```\nThe voice path is fixed. It now skips diagrams. Additional details stay private.'
    planner.update(snapshot({ running: true, partialText: answer }))
    expect(spoken).toEqual(['The voice path is fixed.', 'It now skips diagrams.'])
    planner.update(snapshot({ running: false, finalText: answer }))
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.responseText).not.toContain('Microphone')
    expect(summaries[0]!.responseText).not.toContain('↓')
  })

  it('does not request a summary until the durable assistant and turn end are both present', () => {
    const spoken: string[] = []
    const summaries: SpeechSummaryRequest[] = []
    const planner = new ResponseSpeechPlanner((text) => spoken.push(text), () => undefined, (request) => summaries.push(request))
    planner.reset(snapshot({ running: false }))
    const answer = 'First. Second. Held third. Held fourth.'
    planner.update(snapshot({ running: true, partialText: answer }))

    planner.update(snapshot({ running: false, finalText: answer, turnEnded: false }))
    expect(spoken).toEqual(['First.', 'Second.'])
    expect(summaries).toEqual([])

    planner.update(snapshot({ running: false, finalText: answer }))
    expect(spoken).toEqual(['First.', 'Second.'])
    expect(summaries).toHaveLength(1)
    planner.dispose()
  })

  it('requires final turn completion even when no partial text was published', () => {
    const spoken: string[] = []
    const summaries: SpeechSummaryRequest[] = []
    const planner = new ResponseSpeechPlanner((text) => spoken.push(text), () => undefined, (request) => summaries.push(request))
    planner.reset(snapshot({ running: false }))
    const answer = 'First. Second. Final third. Final fourth.'

    planner.update(snapshot({ running: true }))
    planner.update(snapshot({ running: false, finalText: answer, turnEnded: false }))
    expect(spoken).toEqual([])
    expect(summaries).toEqual([])

    planner.update(snapshot({ running: false, finalText: answer }))
    expect(spoken).toEqual(['First.', 'Second.'])
    expect(summaries[0]?.responseText).toBe('Final third. Final fourth.')
  })

  it('fails open without ever summarizing partial output when finalization never arrives', () => {
    vi.useFakeTimers()
    try {
      const spoken: string[] = []
      const summaries: SpeechSummaryRequest[] = []
      const planner = new ResponseSpeechPlanner((text) => spoken.push(text), () => undefined, (request) => summaries.push(request))
      planner.reset(snapshot({ running: false, finalText: 'Previous answer.', finalTurn: 11 }))
      const answer = 'Current first. Current second. Current held third. Current held fourth.'
      planner.update(snapshot({ running: true, partialText: answer, partialTurn: 12, finalText: 'Previous answer.', finalTurn: 11 }))
      planner.update(snapshot({ running: false, finalText: 'Previous answer.', finalTurn: 11 }))

      expect(summaries).toEqual([])
      vi.advanceTimersByTime(1_000)
      expect(spoken).toEqual(['Current first.', 'Current second.', 'Current held third.', 'Current held fourth.'])
      expect(summaries).toEqual([])
      planner.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('summarizes the exact finalized remainder rather than a predicted partial remainder', () => {
    const spoken: string[] = []
    const summaries: SpeechSummaryRequest[] = []
    const planner = new ResponseSpeechPlanner((text) => spoken.push(text), () => undefined, (request) => summaries.push(request))
    planner.reset(snapshot({ running: false }))
    const partial = 'First. Second. Predicted third detail. Predicted fourth detail.'
    const answer = 'First. Second. Actual completed result. Exact next action.'
    planner.update(snapshot({ running: true, partialText: partial, partialTurn: 15, requestRouteTurn: 15 }))
    planner.update(snapshot({ running: false, partialText: partial, partialTurn: 15, requestRouteTurn: 15 }))
    expect(summaries).toEqual([])

    planner.update(snapshot({
      running: false,
      finalText: answer,
      finalTurn: 15,
      finalHasRoute: false,
      requestRouteTurn: 15,
    }))

    expect(spoken).toEqual(['First.', 'Second.'])
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      responseText: 'Actual completed result. Exact next action.',
      spokenLead: 'First. Second.',
    })
  })

  it('releases interim tool commentary in full without requesting a summary', () => {
    const spoken: string[] = []
    const requestSummary = vi.fn()
    const planner = new ResponseSpeechPlanner((text) => spoken.push(text), () => undefined, requestSummary)
    planner.reset(snapshot({ running: false }))
    planner.update(snapshot({ running: true, partialText: 'Checking one. Checking two. Checking three. Checking four.' }))
    planner.update(snapshot({ running: true, runningCall: true }))

    expect(spoken).toEqual(['Checking one.', 'Checking two.', 'Checking three.', 'Checking four.'])
    expect(requestSummary).not.toHaveBeenCalled()
  })

  it('summarizes the last text node when a tool turn ends on a tool-call node', () => {
    const spoken: string[] = []
    const summaries: SpeechSummaryRequest[] = []
    const planner = new ResponseSpeechPlanner((text) => spoken.push(text), () => undefined, (value) => { summaries.push(value) })
    planner.reset(snapshot({ running: false }))
    planner.update(snapshot({ running: true, partialText: 'First. Second.' }))
    planner.update(snapshot({
      running: false,
      finalText: 'First. Second. Third detail. Fourth detail.',
      trailingToolNode: true,
    }))

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      spokenLead: 'First. Second.',
      responseText: 'Third detail. Fourth detail.',
    })
    planner.handleSummaryDelta(summaries[0]!.summaryId, 'The remaining details are ready.')
    planner.finishSummary(summaries[0]!.summaryId, true)
    expect(spoken.slice(2)).toEqual(['The remaining details are ready.'])
  })

  it('drops a previous summary delta that arrives after a new utterance resets the planner', () => {
    const spoken: string[] = []
    const summaries: SpeechSummaryRequest[] = []
    const planner = new ResponseSpeechPlanner((text) => spoken.push(text), () => undefined, (request) => summaries.push(request))
    planner.reset(snapshot({ running: false }))
    const answer = 'First. Second. Third detail. Fourth detail.'
    planner.update(snapshot({ running: true, partialText: answer }))
    planner.update(snapshot({ running: false, finalText: answer }))
    const firstSummaryId = summaries[0]!.summaryId
    expect(summaries).toHaveLength(1)

    // A new utterance begins (reset) while the first summary is in flight.
    planner.reset(snapshot({ running: false }))
    // Late streamed summary text for the PREVIOUS request must not play.
    planner.handleSummaryDelta(firstSummaryId, 'Stale summary text from the old turn.')
    planner.finishSummary(firstSummaryId, true)
    expect(spoken).toEqual(['First.', 'Second.'])
  })

  it('treats a new typed user message as a turn boundary: cancels the old tail and speaks only the new response', () => {
    const speech: Array<{ text: string; clientTag?: string; summaryHandoff?: boolean }> = []
    const summaries: SpeechSummaryRequest[] = []
    const boundaries: string[] = []
    const planner = new ResponseSpeechPlanner(
      (text, options) => speech.push({ text, ...options }),
      () => undefined,
      (request) => summaries.push(request),
      true,
      () => boundaries.push('boundary'),
    )
    planner.reset(snapshot({ running: false }))
    const answer = 'First outcome. Second context. Third detail. Fourth detail.'
    planner.update(snapshot({ running: true, partialText: answer }))
    for (const opening of speech) if (opening.clientTag) planner.handleSpeechStarted(opening.clientTag)
    planner.update(snapshot({ running: false, finalText: answer }))
    const firstSummaryId = summaries[0]!.summaryId
    expect(summaries).toHaveLength(1)
    expect(boundaries).toEqual([])

    // The user typed the next prompt in the composer (never touched the mic).
    // A new user node appears before the next response streams.
    planner.update(snapshot({ running: false, userText: 'typed prompt', userSeq: 900 }))
    expect(boundaries).toEqual(['boundary'])

    // The previous turn's summary must not still be consumed.
    speech.length = 0
    planner.handleSummaryDelta(firstSummaryId, 'Old summary text that must not play.')
    planner.finishSummary(firstSummaryId, true)
    expect(speech).toEqual([])

    // The next response streams cleanly as the active turn.
    planner.update(snapshot({ running: true, partialText: 'Brand new reply. Fresh second sentence.', requestRouteTurn: 2 }))
    planner.update(snapshot({ running: false, finalText: 'Brand new reply. Fresh second sentence.', finalTurn: 2 }))
    expect(speech.map((entry) => entry.text)).toEqual(['Brand new reply.', 'Fresh second sentence.'])
  })
})

function snapshot(options: {
  readonly running: boolean
  readonly partialText?: string
  readonly finalText?: string
  readonly runningCall?: boolean
  readonly partialTurn?: number
  readonly finalTurn?: number
  readonly finalHasRoute?: boolean
  readonly requestRouteTurn?: number
  readonly turnEnded?: boolean
  readonly trailingToolNode?: boolean
  readonly userText?: string
  readonly userSeq?: number
}): VoiceConversationSnapshot {
  const userNode = options.userText !== undefined
    ? [{
        kind: 'user' as const,
        seq: options.userSeq ?? 1,
        time: Date.now(),
        content: [{ type: 'text' as const, text: options.userText }],
        source: { kind: 'user' as const, rpcId: 'rpc-1' },
      }]
    : []
  return {
    running: options.running,
    runningCalls: options.runningCall ? [{ callId: 'call-1' }] : [],
    partial: options.partialText
      ? { turn: options.partialTurn ?? 1, step: 1, blocks: [{ kind: 'text', text: options.partialText }] }
      : null,
    nodes: [
      ...userNode,
      ...(options.finalText
        ? [{
            kind: 'assistant',
            turn: options.finalTurn ?? 1,
            step: 1,
            blocks: [{ kind: 'text', text: options.finalText }],
            ...(options.finalHasRoute === false ? {} : { provenance: { provider: 'openai-codex', model: 'gpt-test' } }),
          }]
        : []),
      // Tool-using turns end on a tool-call node with no text blocks.
      ...(options.finalText && options.trailingToolNode
        ? [{
            kind: 'assistant',
            turn: options.finalTurn ?? 1,
            step: 1,
            blocks: [{ kind: 'tool-call', callId: 'call-1' }],
          }]
        : []),
    ],
    turnEnds: options.finalText && options.turnEnded !== false
      ? new Map([[options.finalTurn ?? 1, 1]])
      : new Map(),
    views: {
      get: (target: string) => target === 'trajectory' && options.requestRouteTurn !== undefined
        ? {
            requests: [{
              purpose: 'assistant',
              turn: options.requestRouteTurn,
              requestConfig: { provider: 'openai-codex', model: 'gpt-test' },
            }],
          }
        : undefined,
    },
  } as unknown as VoiceConversationSnapshot
}
