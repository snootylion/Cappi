import test from 'node:test'
import assert from 'node:assert/strict'
import { makeQuestionAnswer } from './dsh.mjs'

const question = { id: 'q-1', options: [{ label: 'A' }, { label: 'B' }], multi_select: false }

test('single choice submits exactly its label', () => {
  assert.deepEqual(makeQuestionAnswer(question, 'A'), { id: 'q-1', selected: ['A'] })
  assert.throws(() => makeQuestionAnswer(question, ['A', 'B']), /invalid answer choice/)
  assert.throws(() => makeQuestionAnswer(question, 'not offered'), /invalid answer choice/)
})

test('multi-select accepts a checked set and rejects unknown labels', () => {
  const multi = { ...question, multi_select: true }
  assert.deepEqual(makeQuestionAnswer(multi, ['A', 'B']), { id: 'q-1', selected: ['A', 'B'] })
  assert.throws(() => makeQuestionAnswer(multi, ['A', 'X']), /invalid answer choice/)
})

test('custom dictated answer is never empty and is separate from options', () => {
  assert.deepEqual(makeQuestionAnswer(question, '_free', ' A nuanced answer '),
    { id: 'q-1', selected: [], custom: 'A nuanced answer' })
  assert.throws(() => makeQuestionAnswer(question, '_free', ' '), /answer is empty/)
})
