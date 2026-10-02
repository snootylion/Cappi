import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogOptions, createModelCommands, ModelProjectionCache, modelValue, MODEL_SCOPE_HINT } from './models.mjs'
import { __resetDshStateForTests, applySessionList, handleFollowValue, handleControlValue,
  getModelSelectionProjection } from './dsh.mjs'

const selection = { provider: 'provider-a', model: 'model/a', reasoningEffort: 'high' }
const catalog = () => ({
  default: { provider: 'provider-a', model: 'model/a' },
  routableProviders: ['provider-a', 'provider-b'],
  groups: [
    { id: 'provider-a', name: 'Provider A', models: [
      { id: 'model/a', name: 'Model A', reasoning: { defaultEffort: 'medium' } },
      { id: 'model/b', name: 'Model B', reasoning: { defaultEffort: 'low' } },
    ] },
    { id: 'provider-b', name: 'Provider B', models: [{ id: 'model/a', name: 'Other A' }] },
    { id: 'offline', name: 'Unavailable provider', models: [{ id: 'hidden', name: 'Hidden' }] },
  ], failures: [],
})
const projection = next => ({ next, lastUsed: null })
function fixture () {
  const f = { target: { sessionId: 'thread-a', revision: 1, running: true },
    projection: projection(selection), catalog: catalog(), calls: [],
    read: null, write: null }
  f.api = createModelCommands({
    getTarget: () => f.target,
    getProjection: () => f.projection,
    rpc: async (method, args) => {
      f.calls.push({ method, args })
      if (method === 'session/modelCatalog') return f.read ? f.read() : f.catalog
      assert.equal(method, 'session/selectModel', 'no prompt/command/create fallback is permitted')
      return f.write ? f.write(args.request) : { selected: { provider: args.request.provider,
        model: args.request.model, ...(args.request.reasoningEffort ? { reasoningEffort: args.request.reasoningEffort } : {}) } }
    },
  })
  return f
}
const writes = f => f.calls.filter(c => c.method === 'session/selectModel')
const code = status => e => e.status === status
function deferred () {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('runtime catalog maps names/provider identities and excludes unroutable groups', () => {
  const options = catalogOptions(catalog())
  assert.equal(options.length, 3)
  assert.deepEqual(options[0], { value: modelValue('provider-a', 'model/a'), name: 'Model A',
    provider: 'provider-a', providerName: 'Provider A', modelId: 'model/a' })
  assert.notEqual(options[0].value, options[2].value, 'same model id under different providers stays distinct')
  assert.notEqual(modelValue('a/b', 'c'), modelValue('a', 'b/c'))
  assert.ok(!options.some(o => o.provider === 'offline'))
})

test('catalog deduplicates and skips malformed rows without inventing models', () => {
  const c = catalog()
  c.groups.unshift(null, { id: 'provider-a', models: [] })
  c.groups.push(c.groups[2])
  c.groups[2].models.push(null, { id: '' })
  assert.equal(catalogOptions(c).length, 3)
  assert.throws(() => catalogOptions({}), code(502))
})

test('list uses the selected thread projection, never the catalog default over a selection', async () => {
  const f = fixture()
  f.projection = projection({ provider: 'provider-b', model: 'model/a' })
  const state = await f.api.models('thread-a')
  assert.equal(state.sessionId, 'thread-a')
  assert.equal(state.currentValue, modelValue('provider-b', 'model/a'))
  assert.deepEqual(state.current, f.projection.next)
  assert.equal(state.scopeHint, MODEL_SCOPE_HINT)
  assert.equal(state.updatesDefault, true)
  assert.equal(writes(f).length, 0)
})

test('a loaded null next inherits the real runtime default; unloaded/malformed never does', async () => {
  const f = fixture()
  f.projection = projection(null)
  assert.deepEqual((await f.api.models('thread-a')).current, f.catalog.default)
  for (const invalid of [undefined, null, {}, { next: {} }]) {
    f.projection = invalid
    await assert.rejects(f.api.models('thread-a'), code(503))
    await assert.rejects(f.api.setModel('thread-a', modelValue('provider-a', 'model/b')), code(503))
  }
  assert.equal(writes(f).length, 0)
})

test('missing or stale captured thread is rejected before even reading the catalog', async () => {
  const f = fixture()
  for (const id of [undefined, '', 'another-thread', 42]) {
    await assert.rejects(f.api.models(id), code(409))
    await assert.rejects(f.api.setModel(id, 'model'), code(409))
  }
  assert.equal(f.calls.length, 0)
})

test('thread switch while catalog loads rejects list and write, including A -> B -> A', async () => {
  for (const operation of ['models', 'setModel']) {
    for (const returnedToA of [false, true]) {
      const f = fixture(); const gate = deferred()
      f.read = () => gate.promise
      const result = f.api[operation]('thread-a', modelValue('provider-a', 'model/b'))
      f.target = { sessionId: returnedToA ? 'thread-a' : 'thread-b', revision: 3 }
      gate.resolve(catalog())
      await assert.rejects(result, code(409))
      assert.equal(writes(f).length, 0)
    }
  }
})

test('last synchronous guard rejects a changed target immediately before native dispatch', async () => {
  let target = { sessionId: 'thread-a', revision: 1 }
  const calls = []
  const api = createModelCommands({
    getTarget: () => target,
    getProjection: () => { target = { sessionId: 'thread-b', revision: 2 }; return projection(selection) },
    rpc: async method => { calls.push(method); return catalog() },
  })
  await assert.rejects(api.setModel('thread-a', modelValue('provider-a', 'model/b')), code(409))
  assert.deepEqual(calls, ['session/modelCatalog'])
})

test('model IDs are checked against a fresh allowlist, never decoded as arbitrary input', async () => {
  const f = fixture()
  const stale = (await f.api.models('thread-a')).options.find(o => o.modelId === 'model/b').value
  f.catalog.groups[0].models = f.catalog.groups[0].models.filter(m => m.id !== 'model/b')
  for (const id of [stale, '/model evil\n/do-something', modelValue('unknown-provider', 'model/a'),
    modelValue('offline', 'hidden'), '{}', '']) {
    await assert.rejects(f.api.setModel('thread-a', id), code(400))
  }
  assert.equal(writes(f).length, 0)
})

test('native selection uses captured thread and catalog default effort; work need not be idle', async () => {
  const f = fixture()
  const result = await f.api.setModel('thread-a', modelValue('provider-a', 'model/b'))
  assert.deepEqual(writes(f), [{ method: 'session/selectModel', args: { request: {
    sessionId: 'thread-a', provider: 'provider-a', model: 'model/b', reasoningEffort: 'low' } } }])
  assert.deepEqual(result.current, { provider: 'provider-a', model: 'model/b', reasoningEffort: 'low' })
  assert.deepEqual(result.selected, result.current)
  assert.equal(result.currentValue, modelValue('provider-a', 'model/b'))
  assert.equal(result.options.length, 3)
  assert.equal(result.targetChanged, false)
  assert.equal(result.defaultSaved, undefined, 'native API does not confirm persisted-default success')
  assert.equal(f.calls.filter(c => c.method === 'session/modelCatalog').length, 1, 'no racy post-write catalog read')
  assert.deepEqual(f.projection.next, selection, 'only durable projection events may update the cache')
})

test('reselecting current model preserves existing effort, model with no default omits it', async () => {
  const f = fixture()
  await f.api.setModel('thread-a', modelValue('provider-a', 'model/a'))
  assert.equal(writes(f)[0].args.request.reasoningEffort, 'high')
  await f.api.setModel('thread-a', modelValue('provider-b', 'model/a'))
  assert.equal(Object.hasOwn(writes(f)[1].args.request, 'reasoningEffort'), false)
})

test('only an actual native selected result confirms success; normalized selection is retained', async () => {
  const f = fixture()
  const normalized = { provider: 'canonical-provider', model: 'canonical-model', reasoningEffort: 'max' }
  f.write = () => ({ selected: normalized })
  const result = await f.api.setModel('thread-a', modelValue('provider-a', 'model/b'))
  assert.deepEqual(result.selected, normalized)
  assert.equal(result.currentValue, modelValue(normalized.provider, normalized.model))
  assert.ok(!result.options.some(o => o.value === result.currentValue))
  for (const invalid of [undefined, {}, { selected: {} }]) {
    f.write = () => invalid
    await assert.rejects(f.api.setModel('thread-a', modelValue('provider-a', 'model/b')), code(502))
  }
})

test('native failures never claim success or modify the projection; no automatic retry', async () => {
  const f = fixture()
  f.write = () => { throw new Error('native validation failed') }
  await assert.rejects(f.api.setModel('thread-a', modelValue('provider-a', 'model/b')),
    e => e.status === 502 && /Refresh before retrying/.test(e.message))
  assert.equal(writes(f).length, 1)
  assert.deepEqual(f.projection.next, selection)
})

test('concurrent duplicate model writes fail closed, and the lock releases after settlement', async () => {
  const f = fixture(); const gate = deferred()
  f.write = () => gate.promise
  const first = f.api.setModel('thread-a', modelValue('provider-a', 'model/b'))
  await assert.rejects(f.api.setModel('thread-a', modelValue('provider-a', 'model/a')), code(409))
  gate.resolve({ selected: selection }); await first
  f.write = () => ({ selected: selection })
  await f.api.setModel('thread-a', modelValue('provider-a', 'model/a'))
  assert.equal(writes(f).length, 2)
})

test('switch after dispatch cannot retarget an in-flight RPC or falsely label its result', async () => {
  const f = fixture()
  f.write = () => {
    f.target = { sessionId: 'thread-b', revision: 2 }
    return { selected: selection }
  }
  const result = await f.api.setModel('thread-a', modelValue('provider-a', 'model/a'))
  assert.equal(writes(f)[0].args.request.sessionId, 'thread-a')
  assert.equal(result.sessionId, 'thread-a')
  assert.equal(result.targetChanged, true)
})

test('projection cache rejects old sequences and malformed values, and resets to unloaded', () => {
  const c = new ModelProjectionCache()
  assert.equal(c.value, undefined)
  c.apply(projection(selection), 10)
  c.apply(projection(null), 9)
  assert.deepEqual(c.value.next, selection)
  c.apply(projection(null), 11)
  assert.equal(c.value.next, null)
  c.apply({ next: { provider: 'bad' } }, 12)
  assert.equal(c.value, undefined)
  c.apply(projection(selection), 11)
  assert.equal(c.value, undefined)
  c.reset(); c.apply(projection(selection), 1)
  assert.deepEqual(c.value.next, selection)
})

test('DSH follow/control integrate only current-thread model projections and clear on switch', () => {
  __resetDshStateForTests()
  applySessionList([{ sessionId: 'thread-a', running: false }])
  assert.equal(getModelSelectionProjection(), undefined)
  handleFollowValue({ type: 'snapshot', records: [], projections: {
    asOfSeq: 10, values: { modelSelection: projection(selection) } } })
  assert.deepEqual(getModelSelectionProjection().next, selection)
  handleControlValue({ type: 'projection', sessionId: 'other-thread', key: 'modelSelection',
    seq: 500, value: projection(null) })
  assert.deepEqual(getModelSelectionProjection().next, selection)
  handleControlValue({ type: 'projection', sessionId: 'thread-a', key: 'modelSelection',
    seq: 11, value: projection({ provider: 'provider-b', model: 'model/a' }) })
  handleFollowValue({ type: 'snapshot', records: [], projections: {
    asOfSeq: 10, values: { modelSelection: projection(selection) } } })
  assert.equal(getModelSelectionProjection().next.provider, 'provider-b', 'older snapshot cannot overwrite newer control event')
  applySessionList([{ sessionId: 'thread-b', running: false }])
  assert.equal(getModelSelectionProjection(), undefined)
  handleControlValue({ type: 'baseline', value: { projections: {
    'thread-a': { asOfSeq: 20, values: { modelSelection: projection(selection) } },
    'thread-b': { asOfSeq: 1, values: { modelSelection: projection(null) } },
  } } })
  assert.equal(getModelSelectionProjection().next, null)
  const externalCopy = getModelSelectionProjection(); externalCopy.next = selection
  assert.equal(getModelSelectionProjection().next, null, 'diagnostic getter cannot mutate cache')
  __resetDshStateForTests()
})
