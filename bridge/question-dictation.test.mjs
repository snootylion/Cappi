import test from 'node:test'
import assert from 'node:assert/strict'
import { routeAsrFinal } from './bridge.mjs'

function captureFinal(capture, pending) {
  const drafts = [], prompts = []
  const route = routeAsrFinal({ capture, pending, text: 'A nuanced answer', utteranceId: 'u1',
    draft: event => drafts.push(event), prompt: (...args) => prompts.push(args) })
  return { route, drafts, prompts }
}

test('question dictation produces a draft only and never submits a prompt', () => {
  const result = captureFinal({ requestId: 'ask-1', title: 'Question' }, { id: 'ask-1', title: 'Question' })
  assert.equal(result.route, 'draft')
  assert.deepEqual(result.prompts, [])
  assert.deepEqual(result.drafts, [{ t: 'dictation-final', requestId: 'ask-1', text: 'A nuanced answer' }])
})

test('cancelled or changed question discards speech rather than queuing it', () => {
  const result = captureFinal({ requestId: 'ask-1', title: 'Old question' }, null)
  assert.equal(result.route, 'draft')
  assert.deepEqual(result.drafts, [])
  assert.deepEqual(result.prompts, [])
})

test('normal microphone still routes final transcript to prompt', () => {
  const result = captureFinal(null, null)
  assert.equal(result.route, 'prompt')
  assert.deepEqual(result.drafts, [])
  assert.deepEqual(result.prompts, [['A nuanced answer', 'u1']])
})
