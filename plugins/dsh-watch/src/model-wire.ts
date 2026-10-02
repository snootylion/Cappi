import type { SessionCatalog } from './host-adapter.ts';
export type Selection = SessionCatalog['default'];
export function modelValue(provider: string, model: string): string {
  return Buffer.from(JSON.stringify([provider, model]), 'utf8').toString('base64url');
}
function selection(value: unknown): Selection | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Record<string, unknown>;
  return typeof s.provider === 'string' && typeof s.model === 'string' && s.provider && s.model
    ? { provider: s.provider, model: s.model, ...(typeof s.reasoningEffort === 'string' ? { reasoningEffort: s.reasoningEffort } : {}) } : null;
}
export function modelState(sessionId: string, catalog: SessionCatalog, projection: unknown) {
  const p = projection && typeof projection === 'object' ? projection as Record<string, unknown> : undefined;
  if (!p || !Object.hasOwn(p, 'next') || (p.next !== null && !selection(p.next))) throw Object.assign(new Error('Thread model is still loading; reselect or refresh'), { status: 503 });
  const current = selection(p.next) ?? catalog.default;
  const options = catalog.groups.filter(g => catalog.routableProviders.includes(g.id)).flatMap(g => g.models.map(m => ({ value: modelValue(g.id, m.id), name: m.name || m.id, provider: g.id, providerName: g.name, modelId: m.id })));
  const native = catalog.groups.find(g => g.id === current.provider)?.models.find(m => m.id === current.model);
  const metadata = native?.reasoning;
  const efforts = metadata?.efforts ?? [];
  const reasoningOptions = [...(metadata && metadata.defaultEffort === undefined ? [{ value: 'provider-default', name: 'Provider default' }] : []), ...efforts.map(e => ({ value: `effort:${e.id}`, name: e.name || e.id, ...(e.description ? { description: e.description } : {}) }))];
  const defaultValue = metadata?.defaultEffort ? `effort:${metadata.defaultEffort}` : reasoningOptions.some(o => o.value === 'provider-default') ? 'provider-default' : null;
  const effective = current.reasoningEffort ? `effort:${current.reasoningEffort}` : defaultValue;
  return { sessionId, options, current, currentValue: modelValue(current.provider, current.model), scopeHint: 'Session-local model selection', updatesDefault: false,
    reasoning: { modelId: modelValue(current.provider, current.model), options: reasoningOptions, currentValue: reasoningOptions.some(o => o.value === effective) ? effective : null, defaultValue, adjustable: reasoningOptions.length > 1, unavailableReason: reasoningOptions.length > 1 ? null : 'No adjustable reasoning levels are exposed for this model' } };
}
