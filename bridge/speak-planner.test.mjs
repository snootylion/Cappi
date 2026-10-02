// speak-planner.test.mjs — deterministic offline tests for the response speech
// planner: streamed cumulative feeds, duplicate feeds, eager 2-sentence blocks +
// tool-boundary flush, short direct tail vs summarized tail (caps + fail-open),
// FIFO single-utterance queue, voice-off silence, reset dropping queued speech,
// reconnect baselines (no prefix re-narration), reconcile mid-stream finalize,
// and flush idempotence.
//
// Run: node --test bridge/   (imports bridge.mjs without starting anything)

import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpeakPlanner } from './bridge.mjs'

function makePlanner (opts = {}) {
  const spoken = []       // { text, opts }
  const summaries = []    // summarize request bodies
  let id = 0
  const planner = createSpeakPlanner({
    speak: async (text, o) => { spoken.push({ text, opts: o ?? null }) },
    canSpeak: opts.canSpeak ?? (() => true),
    summarize: async (req) => {
      if (opts.summarizeFail) throw new Error('summary unavailable')
      summaries.push(req)
    },
    onSummary: opts.onSummary ?? null,
    userText: () => 'what should I do next',
    idMint: () => `sum-${++id}`,
    ...(opts.extra ?? {}),
  })
  return { planner, spoken, summaries, texts: () => spoken.map(s => s.text) }
}

test('streamed cumulative feed speaks each sentence once; duplicate feeds are no-ops', async () => {
  const { planner, texts } = makePlanner()

  planner.feed('Hello there.')
  await planner.idle()
  assert.deepEqual(texts(), ['Hello there.'])

  planner.feed('Hello there.')                      // duplicate delta
  await planner.idle()
  assert.deepEqual(texts(), ['Hello there.'])

  planner.feed('Hello there. How are')              // no completed new sentence
  await planner.idle()
  assert.deepEqual(texts(), ['Hello there.'])

  planner.feed('Hello there. How are you?')
  await planner.idle()
  assert.deepEqual(texts(), ['Hello there.', 'How are you?'])
  assert.equal(planner.state().sentenceCount, 2)     // block cap reached
})

test('tool-boundary flush speaks the held remainder verbatim and is idempotent', async () => {
  const { planner, texts } = makePlanner()
  planner.feed('First sentence done. Second sentence done. Third sentence here.')
  await planner.idle()
  assert.deepEqual(texts(), ['First sentence done.', 'Second sentence done.']) // eager cap 2

  planner.flushBlock()
  await planner.idle()
  assert.deepEqual(texts(), ['First sentence done.', 'Second sentence done.', 'Third sentence here.'])
  const full = 'First sentence done. Second sentence done. Third sentence here.'
  assert.equal(planner.state().spokenChars, full.length)

  planner.flushBlock()                              // idempotent: nothing held left
  await planner.idle()
  assert.equal(texts().length, 3)
  assert.equal(planner.state().sentenceCount, 0)     // next block may open fresh
})

test('short final tail is spoken directly — no summarize round-trip; double finalize ignored', async () => {
  const { planner, texts, summaries } = makePlanner()
  planner.feed('First sentence done.')
  await planner.idle()
  await planner.finalize('First sentence done. Second tail remains right here.')
  await planner.idle()

  assert.deepEqual(texts(), ['First sentence done.', 'Second tail remains right here.'])
  assert.equal(summaries.length, 0)

  await planner.finalize('First sentence done. Second tail remains right here.')
  await planner.idle()
  assert.equal(texts().length, 2)
  assert.equal(summaries.length, 0)
})

test('long final tail summarizes the exact unsent region; caps enforced; late/unknown ids ignored', async () => {
  const s1 = 'Opening result.'
  const s2 = 'Important context for the reader lands here early on.'
  const s3 = 'Detail clause number one carries the actual findings forward for the reader in careful, complete language that keeps every qualifier attached to the original claim so that nothing important is ever lost when this text is spoken out loud.'
  const s4 = 'Detail clause number two keeps the momentum going with additional context and a closing thought that pads the unsent region comfortably past the four hundred character threshold required to engage summarize at all.'
  const full = `${s1} ${s2} ${s3} ${s4}`
  const { planner, texts, summaries } = makePlanner()

  planner.feed(full)
  await planner.idle()
  assert.deepEqual(texts(), [s1, s2])               // eager 2; s3+s4 held for finalize

  await planner.finalize(full)
  await planner.idle()
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].responseText, `${s3} ${s4}`, 'summarize gets exactly the unsent region')
  assert.equal(summaries[0].spokenLead, `${s1} ${s2}`)
  assert.equal(summaries[0].userText, 'what should I do next')
  assert.equal(texts().length, 2, 'nothing of the held tail spoken verbatim yet')

  const id = summaries[0].summaryId
  planner.handleSummaryDelta('not-the-id', 'Bogus sentence.')      // unknown id ignored
  planner.handleSummaryDelta(id, 'Summary one. Summary two. Summary three. Summary four dropped.')
  await planner.idle()
  assert.deepEqual(texts(), [s1, s2, 'Summary one.', 'Summary two.', 'Summary three.']) // cap 3

  planner.finishSummary(id, true)
  await planner.idle()
  assert.equal(texts().length, 5, 'no fourth summary sentence, no verbatim fallback after success')
  planner.handleSummaryDelta(id, 'Extra after done.')              // late delta ignored
  await planner.idle()
  assert.equal(texts().length, 5)
})

test('summary word cap bounds the spoken sentence; remainder is dropped, not appended', async () => {
  const { planner, spoken, texts, summaries } = makePlanner({ extra: { maxSummaryWords: 12 } })
  const w3 = 'Tail continues for a very long stretch of characters exceeding the direct speak limit comfortably today with extra padding words and then some more descriptive material appended right here for safety and clarity in the recorded test output.'
  const w4 = 'Another tail clause remains beyond this point of the transcript in full, carrying the remaining evidence body forward without any loss of meaning for the listener whatsoever at this moment in the test run.'
  const full = 'Opening result. Second eager sentence lands here now. ' + w3 + ' ' + w4
  planner.feed(full)
  await planner.idle()
  await planner.finalize(full)
  await planner.idle()
  assert.equal(summaries.length, 1)

  const id = summaries[0].summaryId
  planner.handleSummaryDelta(id, 'This first summary sentence easily contains more than twelve words total to trip the word cap.')
  planner.finishSummary(id, true)
  await planner.idle()
  const summarySpeech = texts().slice(2)
  assert.equal(summarySpeech.length, 1)
  const words = summarySpeech[0].split(/\s+/)
  assert.ok(words.length <= 12, `capped speech has ${words.length} words`)
  assert.ok(summarySpeech[0].endsWith('.'), 'truncated speech ends with a period')
  assert.ok(spoken.every(s => typeof s.text === 'string' && s.text.length > 0))
})

test('summarize failure fails open to the full held tail verbatim', async () => {
  const s1 = 'Opening result.'
  const s2 = 'Second eager sentence lands here now for the reader.'
  const s3 = 'Tail clause alpha provides the long evidence body that must never be lost by speech even when summarization fails, because the watcher deserves the full visible reply through their speaker right now.'
  const s4 = 'Tail clause beta finishes the visible reply before the turn ends cleanly, and it keeps going for long enough that this whole unsent region totals over four hundred characters in length for the test itself.'
  const full = `${s1} ${s2} ${s3} ${s4}`
  const { planner, texts, summaries } = makePlanner({ summarizeFail: true })

  planner.feed(full)
  await planner.idle()
  assert.deepEqual(texts(), [s1, s2])

  await planner.finalize(full)
  await planner.idle()
  assert.equal(summaries.length, 0, 'summarize was attempted and failed')
  assert.deepEqual(texts(), [s1, s2, s3, s4], 'fail-open reads the whole unsent tail in order')
})

test('utterances are strictly FIFO with at most one speak in flight', async () => {
  const order = []
  let inFlight = 0
  let maxInFlight = 0
  const planner = createSpeakPlanner({
    speak: async (t) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      order.push(`start:${t}`)
      await new Promise(r => setImmediate(r))
      order.push(`end:${t}`)
      inFlight--
    },
    canSpeak: () => true,
    summarize: async () => {},
    userText: () => '',
  })

  planner.feed('One. Two. Three.')
  await planner.idle()
  planner.flushBlock()
  await planner.idle()

  assert.equal(maxInFlight, 1, 'speech never interleaves')
  assert.deepEqual(order, [
    'start:One.', 'end:One.',
    'start:Two.', 'end:Two.',
    'start:Three.', 'end:Three.',
  ])
})

test('speaker off (canSpeak false) is fully silent — no speak and no summarize', async () => {
  const { planner, texts, summaries } = makePlanner({ canSpeak: () => false })
  const full = 'Opening result. Second eager sentence lands here now. ' +
    'Tail continues for a very long stretch of characters exceeding the direct speak limit comfortably today indeed.'
  planner.feed(full)
  await planner.finalize(full)
  await planner.idle()
  assert.deepEqual(texts(), [])
  assert.equal(summaries.length, 0)
})

test('reset drops queued-but-not-started speech and future stale utterances', async () => {
  let release
  const gate = new Promise(r => { release = r })
  let calls = 0
  const spoken = []
  const planner = createSpeakPlanner({
    speak: async (t) => {
      calls++
      if (calls === 1) await gate
      spoken.push(t)
    },
    canSpeak: () => true,
    summarize: async () => {},
    userText: () => '',
  })

  planner.feed('One. Two.')
  await new Promise(r => setImmediate(r))    // let utterance one reach the gate
  assert.equal(calls, 1)
  assert.deepEqual(spoken, [])

  planner.reset()                            // new turn submitted mid-speech
  release()
  await planner.idle()

  assert.deepEqual(spoken, ['One.'], 'in-flight completes; queued utterances from the old turn are dropped')
  assert.equal(calls, 1)

  planner.feed('Fresh turn text arrives here.')   // post-reset speech works again
  await planner.idle()
  assert.deepEqual(spoken, ['One.', 'Fresh turn text arrives here.'])
})

test('reconnect baseline: existing history is adopted silently, only growth speaks', async () => {
  const { planner, texts } = makePlanner()

  await planner.reconcile('Old committed reply.', false)
  await planner.idle()
  assert.deepEqual(texts(), [], 'history is never re-narrated')

  planner.feed('Old committed reply. New growth arrives.')
  await planner.idle()
  assert.deepEqual(texts(), ['New growth arrives.'])

  await planner.reconcile('Old committed reply.', false)   // identical replay snapshot
  await planner.idle()
  assert.deepEqual(texts(), ['New growth arrives.'])
})

test('reconcile: fresh+done adopts silently; mid-stream done finalizes', async () => {
  const a = makePlanner()
  await a.planner.reconcile('History that finished while we were away.', true)
  await a.planner.idle()
  assert.deepEqual(a.texts(), [], 'fresh planner never narrates a finished turn late')
  assert.equal(a.planner.state().finalized, true)
  a.planner.feed('History that finished while we were away. Extra.')
  await a.planner.idle()
  assert.deepEqual(a.texts(), [], 'finalized planner stays closed')

  const b = makePlanner()
  b.planner.feed('Almost done.')
  await b.planner.idle()
  await b.planner.reconcile('Almost done. Final wrap up.', true)
  await b.planner.idle()
  assert.deepEqual(b.texts(), ['Almost done.', 'Final wrap up.'])
  assert.equal(b.planner.state().finalized, true)
})

test('rewritten/shrunk cumulative text clamps the spoken boundary — no prefix repeat', async () => {
  const { planner, texts } = makePlanner()
  planner.feed('Hello world reply.')
  await planner.idle()
  assert.deepEqual(texts(), ['Hello world reply.'])

  planner.feed('Hello')                        // attempt abandoned → live dropped
  planner.feed('Hello world again.')
  await planner.idle()
  assert.deepEqual(texts(), ['Hello world reply.', 'world again.'])
  assert.ok(!texts().slice(1).some(t => t.startsWith('Hello world reply')), 'prefix never re-spoken')
})

test('summaryHandoff flag set only for the join after a one-sentence lead', async () => {
  const s1 = 'One.'
  const s2 = 'Two.'
  const s3 = 'Three.'
  // One long INCOMPLETE sentence (no terminal period, no interior boundary):
  // eager fill can only speak 'Three.', leaving this whole region unsent for
  // finalize to summarize (>400 chars) with leadCount=1, openings>1.
  const tail = 'Unsent tail body stretches past the direct threshold with plenty of extra characters to qualify for summary handling, and it keeps going with a few more descriptive words to be completely safe about the length here and now for the handoff test run, plus a handful of extra padding words that carry no completed boundary whatsoever, plus some additional filler words to push the region comfortably beyond four hundred total characters'
  const { planner, spoken, summaries } = makePlanner()

  planner.feed(`${s1} ${s2}`)                  // eager pair
  await planner.idle()
  planner.flushBlock()                         // tools start → block boundary
  await planner.idle()
  planner.feed(`${s1} ${s2} ${s3} ${tail}`)    // next step streams a fresh sentence + long body
  await planner.idle()
  assert.equal(planner.state().sentenceCount, 1)   // 'Three.' only; tail has no boundary
  const full = `${s1} ${s2} ${s3} ${tail}`
  await planner.finalize(full)
  await planner.idle()
  assert.equal(summaries.length, 1)

  planner.handleSummaryDelta(summaries[0].summaryId, 'Joined summary sentence arrives here now.')
  await planner.idle()
  const last = spoken.at(-1)
  assert.equal(last.text, 'Joined summary sentence arrives here now.')
  assert.deepEqual(last.opts, { summaryHandoff: true })
  const earlier = spoken.filter(s => s.opts && s.opts.summaryHandoff)
  assert.equal(earlier.length, 1, 'flag only on the first summary sentence')
})
