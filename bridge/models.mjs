// Session-scoped watch model commands. No slash command, prompt, or fallback route.
// Native session/selectModel also saves the default for new/unconfigured threads;
// existing threads with a logged request or explicit selection keep their model.
// This is the native desktop behavior explicitly approved by the user. A default
// save failure is only logged by the native API: updatesDefault describes behavior,
// NOT a persistence success assertion.
export const MODEL_SCOPE_HINT = 'Also used for new or unconfigured threads'

function fail (message, status) { throw Object.assign(new Error(message), { status }) }
const nonempty = v => typeof v === 'string' && v.length > 0
export function modelValue (provider, model) {
  return Buffer.from(JSON.stringify([provider, model]), 'utf8').toString('base64url')
}
export function cleanSelection (value) {
  if (!value || !nonempty(value.provider) || !nonempty(value.model)) return null
  return { provider: value.provider, model: value.model,
    ...(nonempty(value.reasoningEffort) ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/** Monotonic host projection cache; never populated optimistically from a click. */
export class ModelProjectionCache {
  constructor () { this.reset() }
  reset () { this.value = undefined; this.seq = -Infinity }
  apply (value, seq) {
    if (!Number.isSafeInteger(seq) || seq < this.seq) return false
    this.seq = seq
    if (!value || !Object.hasOwn(value, 'next') || (value.next !== null && !cleanSelection(value.next))) {
      this.value = undefined
      return false
    }
    this.value = { next: cleanSelection(value.next), lastUsed: cleanSelection(value.lastUsed) }
    return true
  }
}

export function catalogOptions (catalog) {
  if (!catalog || !Array.isArray(catalog.groups) || !Array.isArray(catalog.routableProviders) ||
      !cleanSelection(catalog.default)) fail('Model catalog is unavailable or malformed', 502)
  const routable = new Set(catalog.routableProviders)
  const seen = new Set()
  const rows = []
  for (const group of catalog.groups) {
    if (!group || !nonempty(group.id) || !routable.has(group.id) || !Array.isArray(group.models)) continue
    for (const model of group.models) {
      if (!model || !nonempty(model.id)) continue
      const value = modelValue(group.id, model.id)
      if (seen.has(value)) continue
      seen.add(value)
      rows.push({ value, name: nonempty(model.name) ? model.name : model.id,
        provider: group.id, providerName: nonempty(group.name) ? group.name : group.id, modelId: model.id })
    }
  }
  return rows
}

function nativeModelFor (catalog, current) {
  if (!catalog.routableProviders.includes(current.provider)) return undefined
  return catalog.groups.flatMap(g => g?.id === current.provider && Array.isArray(g.models) ? g.models : [])
    .find(m => m?.id === current.model)
}

const PROVIDER_DEFAULT = 'provider-default'
const effortValue = id => `effort:${id}`

/** Mirror native ModelSelect: a missing default also offers provider-default. */
export function reasoningState (catalog, current) {
  const nativeModel = nativeModelFor(catalog, current)
  const metadata = nativeModel?.reasoning
  const options = []
  if (metadata && Array.isArray(metadata.efforts)) {
    if (metadata.defaultEffort === undefined) options.push({ value: PROVIDER_DEFAULT, name: 'Provider default' })
    const seen = new Set()
    for (const effort of metadata.efforts) {
      if (!effort || !nonempty(effort.id) || seen.has(effort.id)) continue
      seen.add(effort.id)
      options.push({ value: effortValue(effort.id), name: nonempty(effort.name) ? effort.name : effort.id,
        ...(nonempty(effort.description) ? { description: effort.description } : {}) })
    }
  }
  const defaultValue = nonempty(metadata?.defaultEffort) ? effortValue(metadata.defaultEffort)
    : options.some(o => o.value === PROVIDER_DEFAULT) ? PROVIDER_DEFAULT : null
  const effective = nonempty(current.reasoningEffort) ? effortValue(current.reasoningEffort) : defaultValue
  const currentValue = options.some(o => o.value === effective) ? effective : null
  const adjustable = options.length > 1
  return { modelId: modelValue(current.provider, current.model), options, currentValue, defaultValue,
    adjustable, unavailableReason: adjustable ? null
      : !nativeModel ? 'Current model is not available in the runtime catalog'
        : options.length === 1 && options[0].value !== PROVIDER_DEFAULT
          ? currentValue === options[0].value ? 'This model exposes a single fixed reasoning level'
            : 'Only one reasoning level is advertised; the current effort is unrecognized'
          : 'No adjustable reasoning levels are exposed for this model' }
}

function stateFor (sessionId, catalog, projection) {
  const options = catalogOptions(catalog)
  // Undefined means the actual thread projection has not arrived. Null `next`
  // is different: the host has confirmed this thread uses the current default.
  if (!projection || !Object.hasOwn(projection, 'next') ||
      (projection.next !== null && !cleanSelection(projection.next))) {
    fail('Thread model is still loading; refresh the model list', 503)
  }
  const current = cleanSelection(projection.next) ?? cleanSelection(catalog.default)
  return { sessionId, options, current, currentValue: modelValue(current.provider, current.model),
    reasoning: reasoningState(catalog, current), scopeHint: MODEL_SCOPE_HINT, updatesDefault: true }
}

function sameTarget (a, b) { return a.sessionId === b.sessionId && a.revision === b.revision }

/** Dependencies make all race/allowlist/write tests fully offline. */
export function createModelCommands ({ rpc, getTarget, getProjection }) {
  const selecting = new Set()
  function capture (sessionId) {
    const target = getTarget()
    if (!nonempty(sessionId) || !target.sessionId || sessionId !== target.sessionId) {
      fail('Thread changed or no thread is selected; reopen Switch model', 409)
    }
    return { ...target }
  }
  function check (target) {
    if (!sameTarget(target, getTarget())) fail('Thread changed; reopen Switch model', 409)
  }
  async function load (target) {
    const catalog = await rpc('session/modelCatalog', {})
    check(target) // Includes A -> B -> A switches while the catalog was loading.
    const state = stateFor(target.sessionId, catalog, getProjection())
    return { catalog, state }
  }
  async function select (sessionId, modelId, requestedEffort, reasoningOnly) {
    const target = capture(sessionId)
    if (!nonempty(modelId)) fail('Choose a model from the model list', 400)
    if (reasoningOnly && !nonempty(requestedEffort)) fail('Choose an offered reasoning level', 400)
    // One lock covers BOTH controls: an effort write cannot race our model write.
    if (selecting.has(sessionId)) fail('A model or reasoning selection is already in progress for this thread', 409)
    selecting.add(sessionId)
    try {
      const { catalog, state } = await load(target)
      let request
      if (reasoningOnly) {
        if (state.currentValue !== modelId) fail('Model changed; reopen Reasoning before selecting a level', 409)
        if (!state.reasoning.adjustable) fail(state.reasoning.unavailableReason, 400)
        const choice = state.reasoning.options.find(o => o.value === requestedEffort)
        if (!choice) fail('Reasoning level is no longer available; refresh Reasoning', 400)
        // Decode ONLY a value that exactly matched the fresh native allowlist.
        // The provider-default sentinel is not itself a native effort id.
        request = { sessionId, provider: state.current.provider, model: state.current.model,
          ...(choice.value === PROVIDER_DEFAULT ? {} : { reasoningEffort: choice.value.slice('effort:'.length) }) }
        // Re-read the thread projection after catalog/choice processing. Never
        // intentionally apply an old model just to change its reasoning level.
        const latest = stateFor(sessionId, catalog, getProjection())
        if (latest.currentValue !== modelId) fail('Model changed; reopen Reasoning before selecting a level', 409)
      } else {
        // A fresh runtime allowlist, not a decoded/untrusted arbitrary provider/id.
        const row = state.options.find(o => o.value === modelId)
        if (!row) fail('Model is no longer available; refresh the model list', 400)
        const nativeModel = nativeModelFor(catalog, { provider: row.provider, model: row.modelId })
        // Match desktop /model: same-model effort is retained; a new model uses
        // its catalog default, or leaves resolution to the provider.
        const same = state.current.provider === row.provider && state.current.model === row.modelId
        const effort = (same ? state.current.reasoningEffort : undefined) ?? nativeModel.reasoning?.defaultEffort
        request = { sessionId, provider: row.provider, model: row.modelId,
          ...(nonempty(effort) ? { reasoningEffort: effort } : {}) }
      }
      check(target) // Last synchronous guard immediately before dispatch.
      let result
      try {
        // Native selection is for the next request and allowed during work. The
        // host serializes it with image admission. Its API has NO atomic expected-
        // model/CAS parameter: an external desktop change AFTER this last check
        // can still race an in-flight request. No client can promise otherwise.
        result = await rpc('session/selectModel', { request })
      } catch (e) {
        throw Object.assign(new Error(`Model selection failed or could not be confirmed: ${e.message}. Refresh before retrying.`),
          { status: typeof e.status === 'number' ? e.status : 502 })
      }
      const selected = cleanSelection(result?.selected)
      if (!selected) fail('Model selection was not confirmed; refresh before retrying', 502)
      // Rebuild reasoning for the ACTUAL selected model/effort, not the requested
      // choice. Reuse this catalog: no second fetch and no optimistic cache write.
      return { ...stateFor(sessionId, catalog, { next: selected }), selected,
        targetChanged: !sameTarget(target, getTarget()) }
    } finally { selecting.delete(sessionId) }
  }
  return {
    async models (sessionId) { return (await load(capture(sessionId))).state },
    async setModel (sessionId, modelId) { return select(sessionId, modelId, undefined, false) },
    async setReasoning (sessionId, modelId, reasoningEffort) { return select(sessionId, modelId, reasoningEffort, true) },
  }
}
