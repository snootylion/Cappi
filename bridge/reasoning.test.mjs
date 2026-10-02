import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelCommands, modelValue } from './models.mjs'

const selected = { provider: 'provider-a', model: 'model-a', reasoningEffort: 'balanced' }
const defaultReasoning = () => ({ defaultEffort: 'balanced', efforts: [
  { id: 'balanced', name: 'Balanced', description: 'A balanced amount of reasoning' },
  { id: 'intense-v2', name: 'Intense' },
] })
function fixture () {
  const f = { target: { sessionId: 'thread-a', revision: 1, running: true },
    projection: { next: { ...selected }, lastUsed: null }, calls: [], read: null, write: null }
  f.catalog = {
    default: { provider: 'provider-a', model: 'model-a' }, routableProviders: ['provider-a', 'provider-b'],
    groups: [{ id: 'provider-a', name: 'Provider A', models: [
      { id: 'model-a', name: 'Model A', reasoning: defaultReasoning() },
      { id: 'model-b', name: 'Model B', reasoning: defaultReasoning() },
    ] }, { id: 'provider-b', name: 'Provider B', models: [
      { id: 'model-a', name: 'Another A', reasoning: defaultReasoning() },
    ] }], failures: [],
  }
  f.metadata = f.catalog.groups[0].models[0].reasoning
  f.api = createModelCommands({
    getTarget: () => f.target,
    getProjection: () => f.getProjection ? f.getProjection() : f.projection,
    rpc: async (method, args) => {
      f.calls.push({ method, args })
      if (method === 'session/modelCatalog') return f.read ? f.read() : f.catalog
      assert.equal(method, 'session/selectModel', 'never prompt, slash-command, or create a session')
      return f.write ? f.write(args.request) : { selected: {
        provider: args.request.provider, model: args.request.model,
        ...(Object.hasOwn(args.request, 'reasoningEffort') ? { reasoningEffort: args.request.reasoningEffort } : {}),
      } }
    },
  })
  return f
}
const modelA = modelValue('provider-a', 'model-a')
const modelB = modelValue('provider-a', 'model-b')
const writes = f => f.calls.filter(c => c.method === 'session/selectModel')
const code = status => e => e.status === status
function deferred () { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('models exposes only native effort ids/names/descriptions, using opaque values', async () => {
  const f = fixture()
  const state = await f.api.models('thread-a')
  assert.deepEqual(state.reasoning, {
    modelId: modelA,
    options: [
      { value: 'effort:balanced', name: 'Balanced', description: 'A balanced amount of reasoning' },
      { value: 'effort:intense-v2', name: 'Intense' },
    ],
    currentValue: 'effort:balanced', defaultValue: 'effort:balanced', adjustable: true, unavailableReason: null,
  })
  assert.equal(state.current.reasoningEffort, 'balanced', 'actual native selection remains raw')
  assert.equal(writes(f).length, 0)
})

test('catalog default is effective display only, not fabricated into current selection', async () => {
  const f = fixture(); delete f.projection.next.reasoningEffort
  const state = await f.api.models('thread-a')
  assert.equal(state.reasoning.currentValue, 'effort:balanced')
  assert.equal(Object.hasOwn(state.current, 'reasoningEffort'), false)
})

test('native levels are deduplicated; malformed entries cannot become choices', async () => {
  const f = fixture()
  f.metadata.efforts.push(null, { id: '' }, { id: 5 }, { id: 'balanced', name: 'Duplicate' })
  assert.equal((await f.api.models('thread-a')).reasoning.options.length, 2)
})

test('single explicit effort with no declared default also offers provider-default and is adjustable', async () => {
  const f = fixture()
  delete f.metadata.defaultEffort
  f.metadata.efforts = [{ id: 'balanced', name: 'Balanced' }]
  delete f.projection.next.reasoningEffort
  const r = (await f.api.models('thread-a')).reasoning
  assert.deepEqual(r.options, [
    { value: 'provider-default', name: 'Provider default' },
    { value: 'effort:balanced', name: 'Balanced' },
  ])
  assert.equal(r.currentValue, 'provider-default')
  assert.equal(r.defaultValue, 'provider-default')
  assert.equal(r.adjustable, true)
})

test('unsupported and fixed models are read-only without claiming that the model cannot reason', async () => {
  for (const kind of ['absent', 'empty', 'fixed']) {
    const f = fixture()
    if (kind === 'absent') delete f.catalog.groups[0].models[0].reasoning
    if (kind === 'empty') { f.metadata.efforts = []; delete f.metadata.defaultEffort }
    if (kind === 'fixed') f.metadata.efforts = [{ id: 'balanced', name: 'Balanced' }]
    const r = (await f.api.models('thread-a')).reasoning
    assert.equal(r.adjustable, false)
    assert.ok(r.unavailableReason)
    if (kind === 'fixed') assert.match(r.unavailableReason, /single fixed reasoning level/)
    else assert.match(r.unavailableReason, /No adjustable reasoning levels/)
    if (kind === 'empty') assert.deepEqual(r.options, [{ value: 'provider-default', name: 'Provider default' }])
    await assert.rejects(f.api.setReasoning('thread-a', modelA,
      kind === 'empty' ? 'provider-default' : 'effort:balanced'), code(400))
    assert.equal(writes(f).length, 0)
  }
})

test('unknown current effort is preserved in actual current but does not select an invented row', async () => {
  const f = fixture(); f.projection.next.reasoningEffort = 'historical-custom-effort'
  const state = await f.api.models('thread-a')
  assert.equal(state.current.reasoningEffort, 'historical-custom-effort')
  assert.equal(state.reasoning.currentValue, null)
  assert.equal(state.reasoning.options.length, 2)
})

test('unknown current effort is not mislabeled as the one advertised fixed level', async () => {
  const f = fixture()
  f.metadata.efforts = [{ id: 'balanced', name: 'Balanced' }]
  f.projection.next.reasoningEffort = 'historical-custom-effort'
  const r = (await f.api.models('thread-a')).reasoning
  assert.equal(r.currentValue, null)
  assert.equal(r.adjustable, false)
  assert.match(r.unavailableReason, /current effort is unrecognized/)
  assert.doesNotMatch(r.unavailableReason, /fixed/)
})

test('current model absent from catalog exposes no guessed reasoning controls', async () => {
  const f = fixture(); f.projection.next.model = 'unlisted'
  const state = await f.api.models('thread-a')
  assert.equal(state.reasoning.options.length, 0)
  assert.equal(state.reasoning.adjustable, false)
  assert.match(state.reasoning.unavailableReason, /not available in the runtime catalog/)
  await assert.rejects(f.api.setReasoning('thread-a', state.currentValue, 'effort:balanced'), code(400))
  assert.equal(writes(f).length, 0)
})

test('reasoning writes keep actual provider/model and use only the chosen native effort id', async () => {
  const f = fixture()
  const result = await f.api.setReasoning('thread-a', modelA, 'effort:intense-v2')
  assert.deepEqual(writes(f), [{ method: 'session/selectModel', args: { request: {
    sessionId: 'thread-a', provider: 'provider-a', model: 'model-a', reasoningEffort: 'intense-v2',
  } } }])
  assert.equal(result.currentValue, modelA)
  assert.equal(result.reasoning.currentValue, 'effort:intense-v2')
  assert.equal(result.current.reasoningEffort, 'intense-v2')
  assert.deepEqual(result.selected, result.current)
  assert.equal(result.options.length, 3)
  assert.equal(result.targetChanged, false)
  assert.equal(result.updatesDefault, true)
  assert.equal(f.calls.filter(c => c.method === 'session/modelCatalog').length, 1)
  assert.equal(f.projection.next.reasoningEffort, 'balanced', 'no optimistic projection write')
})

test('provider-default omits the RPC field entirely, never sends null or a made-up native id', async () => {
  const f = fixture(); delete f.metadata.defaultEffort
  const result = await f.api.setReasoning('thread-a', modelA, 'provider-default')
  assert.deepEqual(writes(f)[0].args.request, { sessionId: 'thread-a', provider: 'provider-a', model: 'model-a' })
  assert.equal(Object.hasOwn(result.current, 'reasoningEffort'), false)
  assert.equal(result.reasoning.currentValue, 'provider-default')
})

test('native effort id named provider-default cannot collide with the synthetic default choice', async () => {
  const f = fixture(); delete f.metadata.defaultEffort
  f.metadata.efforts.push({ id: 'provider-default', name: 'Literal native ID' })
  const r = (await f.api.models('thread-a')).reasoning
  assert.ok(r.options.some(o => o.value === 'provider-default'))
  assert.ok(r.options.some(o => o.value === 'effort:provider-default'))
  await f.api.setReasoning('thread-a', modelA, 'effort:provider-default')
  assert.equal(writes(f)[0].args.request.reasoningEffort, 'provider-default')
})

test('unknown, raw, null, missing and unadvertised default choices are rejected without writes', async () => {
  const f = fixture()
  for (const value of ['balanced', 'effort:made-up', 'provider-default', null, undefined, false, '',
    '/model other\n/permission unsafe']) {
    await assert.rejects(f.api.setReasoning('thread-a', modelA, value), code(400))
  }
  assert.equal(writes(f).length, 0)
})

test('an effort removed from fresh catalog is not accepted from an old picker', async () => {
  const f = fixture()
  const old = (await f.api.models('thread-a')).reasoning.options[1].value
  f.metadata.efforts = [{ id: 'balanced', name: 'Balanced' }, { id: 'new-choice', name: 'New' }]
  await assert.rejects(f.api.setReasoning('thread-a', modelA, old), code(400))
  assert.equal(writes(f).length, 0)
})

test('changed current model or provider rejects stale reasoning picker rather than reverting model', async () => {
  for (const next of [{ provider: 'provider-a', model: 'model-b' }, { provider: 'provider-b', model: 'model-a' }]) {
    const f = fixture(); f.projection.next = next
    await assert.rejects(f.api.setReasoning('thread-a', modelA, 'effort:balanced'),
      e => e.status === 409 && /Model changed/.test(e.message))
    assert.equal(writes(f).length, 0)
  }
})

test('model change during catalog loading is rejected before dispatch', async () => {
  const f = fixture(); const gate = deferred()
  f.read = () => gate.promise
  const request = f.api.setReasoning('thread-a', modelA, 'effort:intense-v2')
  f.projection.next = { provider: 'provider-a', model: 'model-b' }
  gate.resolve(f.catalog)
  await assert.rejects(request, code(409))
  assert.equal(writes(f).length, 0)
})

test('current model is re-read immediately before reasoning RPC, not just after catalog load', async () => {
  const f = fixture(); let reads = 0
  f.getProjection = () => {
    if (++reads === 2) f.projection.next = { provider: 'provider-a', model: 'model-b' }
    return f.projection
  }
  await assert.rejects(f.api.setReasoning('thread-a', modelA, 'effort:intense-v2'), code(409))
  assert.equal(reads, 2)
  assert.equal(writes(f).length, 0)
})

test('reasoning keeps captured-thread guards, including last-check session switch and unloaded projection', async () => {
  const stale = fixture()
  await assert.rejects(stale.api.setReasoning('thread-b', modelA, 'effort:balanced'), code(409))
  assert.equal(stale.calls.length, 0)
  const f = fixture(); let reads = 0
  f.getProjection = () => {
    if (++reads === 2) f.target = { sessionId: 'thread-b', revision: 2 }
    return f.projection
  }
  await assert.rejects(f.api.setReasoning('thread-a', modelA, 'effort:balanced'), code(409))
  assert.equal(writes(f).length, 0)
  const unloaded = fixture(); unloaded.projection = undefined
  await assert.rejects(unloaded.api.setReasoning('thread-a', modelA, 'effort:balanced'), code(503))
  assert.equal(writes(unloaded).length, 0)
})

test('model and reasoning writes share one in-flight guard in both directions', async () => {
  for (const firstKind of ['setModel', 'setReasoning']) {
    const f = fixture(); const gate = deferred()
    f.write = () => gate.promise
    const first = f.api[firstKind]('thread-a', modelA, 'effort:intense-v2')
    const otherKind = firstKind === 'setModel' ? 'setReasoning' : 'setModel'
    await assert.rejects(f.api[otherKind]('thread-a', modelA, 'effort:balanced'), code(409))
    gate.resolve({ selected }); await first
    assert.equal(writes(f).length, 1)
    f.write = () => ({ selected })
    await f.api[otherKind]('thread-a', modelA, 'effort:balanced')
    assert.equal(writes(f).length, 2, 'shared lock releases after settlement')
  }
})

test('native-normalized effort, not requested effort, is reported in the complete result', async () => {
  const f = fixture(); f.write = () => ({ selected })
  const result = await f.api.setReasoning('thread-a', modelA, 'effort:intense-v2')
  assert.equal(result.current.reasoningEffort, 'balanced')
  assert.equal(result.reasoning.currentValue, 'effort:balanced')
  assert.equal(result.reasoning.options.length, 2)
})

test('reasoning failures and malformed confirmation never become optimistic success', async () => {
  const f = fixture()
  f.write = () => { throw new Error('rejected by native adapter') }
  await assert.rejects(f.api.setReasoning('thread-a', modelA, 'effort:intense-v2'), code(502))
  f.write = () => ({})
  await assert.rejects(f.api.setReasoning('thread-a', modelA, 'effort:intense-v2'), code(502))
  assert.equal(f.projection.next.reasoningEffort, 'balanced')
})

test('model-selection response rebuilds reasoning metadata for newly selected model', async () => {
  const f = fixture()
  f.catalog.groups[0].models[1].reasoning = { efforts: [{ id: 'only-level', name: 'Only' }], defaultEffort: 'only-level' }
  const state = await f.api.setModel('thread-a', modelB)
  assert.equal(state.reasoning.modelId, modelB)
  assert.equal(state.reasoning.currentValue, 'effort:only-level')
  assert.equal(state.reasoning.adjustable, false)
})
