// follow-events.test.mjs — deterministic offline tests for the follow-stream
// assistant transcript: streamed cumulative updates, duplicate/replayed events,
// multiple interim messages per turn, reconnect snapshot rebuild (incl. the
// assistantStream baseline), session-switch reset, and the stale-running guard.
//
// Run: node --test bridge/   (no network, no credentials, no listening sockets)

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  onDshEvent,
  handleFollowValue,
  getAssistantState,
  applySessionList,
  setActiveSession,
  __resetDshStateForTests,
} from './dsh.mjs'

let captured = []
onDshEvent((ev) => captured.push(ev))

function reset () {
  __resetDshStateForTests()
  captured = []
}
const deltas = () => captured.filter(e => e.t === 'assistant-delta')
const snapshots = () => captured.filter(e => e.t === 'assistant-snapshot')
const resets = () => captured.filter(e => e.t === 'assistant-reset')
const sessionRunning = () => captured.filter(e => e.t === 'session-running')
const dump = () => JSON.stringify(captured)

let seq = 0
const ev = (type, data, s = ++seq) => ({ type: 'event', event: { type, seq: s, time: 1700000000000 + s, data } })
const start = (attemptId, turn, step) => ({ type: 'assistant-stream', frame: { type: 'start', attemptId, revision: 1, startedAfterSeq: 5, turn, step } })
const chunk = (attemptId, index, text) => ({ type: 'assistant-stream', frame: { type: 'chunk', attemptId, revision: index + 2, index, time: 1700000000000 + index, chunk: { type: 'text-delta', index, text } } })
const msg = (turn, step, blocks, s) => ev('assistant/message', {
  turn, step,
  message: { id: `m${s ?? ++seq}`, role: 'assistant', content: blocks },
  usage: {},
}, s)
const textBlock = t => ({ type: 'text', text: t })

test('streamed text deltas accumulate cumulatively; non-text chunks never surface', () => {
  reset()
  handleFollowValue(start('a1', 1, 0))
  handleFollowValue(chunk('a1', 0, 'Hel'))
  handleFollowValue(chunk('a1', 1, 'lo '))
  handleFollowValue(chunk('a1', 2, 'world'))
  // duplicated frame (same index) is dropped
  handleFollowValue(chunk('a1', 2, 'world'))
  // reasoning/tool deltas are not user-visible commentary
  handleFollowValue({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', revision: 9, index: 3, time: 1, chunk: { type: 'reasoning-delta', index: 3, text: 'PRIVATE REASONING' } } })
  handleFollowValue({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', revision: 10, index: 4, time: 1, chunk: { type: 'tool-call-delta', index: 4, id: 't1', name: 'bash', arguments: '{"cmd":"rm -rf /"}' } } })

  assert.deepEqual(deltas().map(e => e.text), ['Hel', 'Hello ', 'Hello world'])
  assert.equal(getAssistantState().text, 'Hello world')
  assert.equal(getAssistantState().done, false)
  assert.ok(!dump().includes('PRIVATE REASONING'), 'reasoning must never reach the watch')
  assert.ok(!dump().includes('rm -rf'), 'tool JSON must never reach the watch')
})

test('durable assistant/message supersedes the live attempt without duplication; replays collapse by seq', () => {
  reset()
  handleFollowValue(start('a1', 1, 0))
  handleFollowValue(chunk('a1', 0, 'Hello '))
  handleFollowValue(chunk('a1', 1, 'world'))

  const m = msg(1, 0, [
    { type: 'reasoning', text: 'SECRET THINKING' },
    textBlock('Hello world'),
    { type: 'tool-call', id: 't1', name: 'bash', arguments: '{"cmd":"ls"}' },
  ], 6)
  handleFollowValue(m)
  // duplicate delivery of the same durable event
  handleFollowValue(m)

  assert.equal(getAssistantState().text, 'Hello world')
  assert.equal(deltas().at(-1).text, 'Hello world')
  const texts = deltas().map(e => e.text)
  assert.ok(!texts.some(t => t.includes('SECRET THINKING')), 'reasoning block excluded')
  assert.ok(!texts.some(t => t.includes('"cmd"')), 'tool-call block excluded')
  // live attempt cleared by the commit: end marker changes nothing
  handleFollowValue({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'a1', revision: 11, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 6 } } })
  assert.equal(getAssistantState().text, 'Hello world')
})

test('multiple interim messages while running join with blank lines; tool-only steps add nothing', () => {
  reset()
  handleFollowValue(ev('turn/start', { turn: 1 }, 1))
  handleFollowValue(ev('user/message', { role: 'user', id: 'u1', content: [textBlock('go')] }, 2))
  handleFollowValue(msg(1, 0, [textBlock('Step one done.')], 10))
  handleFollowValue(msg(1, 1, [{ type: 'tool-call', id: 't2', name: 'bash', arguments: '{}' }], 14))
  handleFollowValue(msg(1, 2, [textBlock('Step two ongoing.')], 18))

  const expected = 'Step one done.\n\nStep two ongoing.'
  assert.equal(getAssistantState().text, expected)
  assert.equal(deltas().at(-1).text, expected)
  // cumulative stream is monotone: every delta is a prefix of the next
  const seen = deltas().map(e => e.text)
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i].startsWith(seen[i - 1]) || seen[i] === expected, `delta ${i} must extend ${i - 1}`)
  }
})

test('follow-open snapshot rebuilds the visible turn: final vs interim labeled, no reset storm', () => {
  reset()
  handleFollowValue({
    type: 'snapshot',
    header: { version: 3, id: 's1', createdAt: 1, cwd: '/x', isSeeded: false },
    cursor: 42,
    hasMore: false,
    projections: { asOfSeq: 42, values: {} },
    assistantStream: { revision: 0 },
    records: [
      ev('turn/start', { turn: 1 }, 1),
      ev('user/message', { role: 'user', id: 'u1', content: [textBlock('q')] }, 2),
      ev('assistant/message', { turn: 1, step: 0, message: { id: 'm6', role: 'assistant', content: [textBlock('Rebuilt reply.')] } }, 6),
      ev('turn/end', { turn: 1, reason: { kind: 'stop' } }, 7),
    ],
  })

  assert.equal(snapshots().length, 1)
  assert.deepEqual(snapshots()[0], { t: 'assistant-snapshot', text: 'Rebuilt reply.', done: true })
  assert.equal(resets().length, 0, 'same-turn replay must not reset the watch or planner')
  assert.deepEqual(getAssistantState(), { text: 'Rebuilt reply.', done: true })
})

test('reopening the same turn mid-stream yields one coherent snapshot, never doubled text', () => {
  reset()
  handleFollowValue(ev('turn/start', { turn: 1 }, 1))
  handleFollowValue(ev('user/message', { role: 'user', id: 'u1', content: [textBlock('q')] }, 2))
  handleFollowValue(msg(1, 0, [textBlock('Live reply.')], 6))

  captured = []   // WS dropped and re-opened with a window containing the same events
  handleFollowValue({
    type: 'snapshot',
    header: { version: 3, id: 's1', createdAt: 1, cwd: '/x', isSeeded: false },
    cursor: 6,
    hasMore: false,
    projections: { asOfSeq: 6, values: {} },
    assistantStream: { revision: 0 },
    records: [
      ev('turn/start', { turn: 1 }, 1),
      ev('user/message', { role: 'user', id: 'u1', content: [textBlock('q')] }, 2),
      ev('assistant/message', { turn: 1, step: 0, message: { id: 'm6', role: 'assistant', content: [textBlock('Live reply.')] } }, 6),
    ],
  })

  assert.equal(deltas().length, 0, 'rebuild emits a single snapshot, not a delta storm')
  assert.equal(resets().length, 0)
  assert.equal(snapshots().length, 1)
  assert.equal(snapshots()[0].text, 'Live reply.')
  assert.equal(snapshots()[0].done, false)
  assert.equal(getAssistantState().text, 'Live reply.')
})

test('a snapshot that crosses into the NEXT turn emits reset then the new interim text', () => {
  reset()
  handleFollowValue(ev('turn/start', { turn: 1 }, 1))
  handleFollowValue(msg(1, 0, [textBlock('Live reply.')], 6))

  captured = []
  handleFollowValue({
    type: 'snapshot',
    header: { version: 3, id: 's1', createdAt: 1, cwd: '/x', isSeeded: false },
    cursor: 9,
    hasMore: false,
    projections: { asOfSeq: 9, values: {} },
    assistantStream: { revision: 0 },
    records: [
      ev('turn/start', { turn: 2 }, 7),
      ev('user/message', { role: 'user', id: 'u2', content: [textBlock('again')] }, 8),
      ev('assistant/message', { turn: 2, step: 0, message: { id: 'm9', role: 'assistant', content: [textBlock('New turn text.')] } }, 9),
    ],
  })

  assert.equal(resets().length, 1, 'turn boundary must reset watch + speech planner')
  assert.equal(snapshots().length, 1)
  assert.deepEqual({ text: snapshots()[0].text, done: snapshots()[0].done }, { text: 'New turn text.', done: false })
  assert.deepEqual(getAssistantState(), { text: 'New turn text.', done: false })
})

test('assistantStream baseline restores mid-attempt text; index replay and abandonment handled', () => {
  reset()
  handleFollowValue({
    type: 'snapshot',
    header: { version: 3, id: 's1', createdAt: 1, cwd: '/x', isSeeded: false },
    cursor: 6,
    hasMore: false,
    projections: { asOfSeq: 6, values: {} },
    assistantStream: {
      revision: 3,
      activeAttempt: {
        attemptId: 'a9',
        startedAfterSeq: 10,
        turn: 1,
        step: 1,
        nextIndex: 5,
        stream: [
          { type: 'text-chunks', time0: 1, index: 0, dt: [0, 10], texts: ['Partial ', 'answer'] },
          { type: 'reasoning-chunks', time0: 1, index: 1, dt: [5], texts: ['hidden thinking'] },
          { type: 'chunk', time: 3, chunk: { type: 'text-delta', index: 2, text: ' now' } },
        ],
      },
    },
    records: [
      ev('turn/start', { turn: 1 }, 1),
      ev('user/message', { role: 'user', id: 'u1', content: [textBlock('q')] }, 2),
      ev('assistant/message', { turn: 1, step: 0, message: { id: 'm4', role: 'assistant', content: [textBlock('Committed.')] } }, 4),
    ],
  })
  assert.equal(getAssistantState().text, 'Committed.\n\nPartial answer now')
  assert.ok(!dump().includes('hidden thinking'), 'reasoning runs in the baseline are excluded')

  // replayed frame already covered by the baseline (index <= nextIndex-1) → dropped
  handleFollowValue(chunk('a9', 3, ' DUPLICATE'))
  assert.equal(getAssistantState().text, 'Committed.\n\nPartial answer now')
  // the next live frame continues the stream
  handleFollowValue(chunk('a9', 5, '!'))
  assert.equal(deltas().at(-1).text, 'Committed.\n\nPartial answer now!')
  // abandoned attempt: never-committed prose must not linger as the reply
  handleFollowValue({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'a9', revision: 9, index: 5, outcome: { kind: 'abandoned' } } })
  assert.equal(getAssistantState().text, 'Committed.')
})

test('durable assistant/attempt settlements are not user-visible', () => {
  reset()
  handleFollowValue(ev('turn/start', { turn: 1 }, 1))
  handleFollowValue(ev('assistant/attempt', {
    turn: 1, step: 0,
    stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [1], texts: ['NOT VISIBLE'] }],
  }, 5))
  assert.equal(getAssistantState().text, '')
  assert.equal(deltas().length, 0)
})

test('stale session/list row cannot re-open a turn after a live turn/end (no wipe race)', () => {
  reset()
  applySessionList([{ sessionId: 's1', running: false, updatedAt: 100, cwd: '/x' }], Date.now())
  captured = []
  handleFollowValue(ev('turn/end', { turn: 1, reason: { kind: 'stop' } }, 7))   // live authority
  assert.ok(sessionRunning().every(e => e.running === false))

  captured = []
  // list row sampled 60s BEFORE the turn/end resolves late: must not emit running:true
  applySessionList([{ sessionId: 's1', running: true, updatedAt: 200, cwd: '/x' }], Date.now() - 60_000)
  assert.equal(sessionRunning().filter(e => e.running === true).length, 0, 'stale running:true must be suppressed')

  captured = []
  // row sampled AFTER the turn event is authoritative again
  applySessionList([{ sessionId: 's1', running: true, updatedAt: 201, cwd: '/x' }], Date.now() + 60_000)
  assert.equal(sessionRunning().at(-1)?.running, true)
})

test('final transcript survives until the next turn boundary; session switch clears it', () => {
  reset()
  applySessionList([{ sessionId: 's1', running: true, updatedAt: 100 }], Date.now())
  handleFollowValue(ev('turn/start', { turn: 1 }, 1))
  handleFollowValue(msg(1, 0, [textBlock('Final words.')], 4))
  handleFollowValue(ev('turn/end', { turn: 1, reason: { kind: 'stop' } }, 5))
  assert.deepEqual(getAssistantState(), { text: 'Final words.', done: true })

  // next user message clears it (and the planner) exactly once
  captured = []
  handleFollowValue(ev('user/message', { role: 'user', id: 'u2', content: [textBlock('next')] }, 6))
  assert.equal(resets().length, 1)
  assert.deepEqual(getAssistantState(), { text: '', done: false })

  // switching sessions clears too
  handleFollowValue(msg(1, 0, [textBlock('Old session reply.')], 7))
  captured = []
  setActiveSession('s2')
  assert.ok(resets().length >= 1, 'session switch must reset watch text + speech planner')
  assert.deepEqual(getAssistantState(), { text: '', done: false })
})
