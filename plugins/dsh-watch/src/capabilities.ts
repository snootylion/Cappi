/**
 * Authenticated bridge capabilities for the watch plugin.
 *
 * The canonical character registry lives bridge-side
 * (characters/registry.json, bound by bridge/characters.mjs). The plugin
 * never duplicates it: it queries `GET /watch/capabilities` (header token,
 * pinned transport) and resolves the requested action against the ACTIVE
 * pack's `modelSelectable` list. The legacy alias table below is a FAIL-FAST
 * mirror only — the bridge re-resolves authoritatively, so a drift here can
 * only refuse early, never widen. Unknown actions and state-owned cues
 * (`question`, `static_hold`) never resolve.
 */

import { checkBridgeUrl, type ResolvedWatchConfig } from './config.ts'
import { BRIDGE_TOKEN_HEADER, readBridgeToken, type BridgeFetch } from './bridge-client.ts'
import { createBridgeFetch } from './pinned-fetch.ts'

export const CAPABILITIES_PATH = '/watch/capabilities'

/** State-owned cues: never model-resolvable, on any pack. */
export const STATE_OWNED_ACTIONS: readonly string[] = Object.freeze(['question', 'static_hold'])

export const CAPPI_CLEAR = 'clear'

/**
 * Fail-fast mirror of the bridge LEGACY_CAPPI_ROLE table (legacy /watch/cappi
 * id → semantic pack role; null = no equivalent). The bridge re-resolves
 * authoritatively — keep the role names (not the mapping outcome) in sync
 * with bridge/characters.mjs. Since the licensed cappi-original pack ships
 * as the registry default, `shadow` maps to `celebrate` (it is directly
 * model-selectable on the default pack).
 */
export const LEGACY_CAPPI_ROLE: Readonly<Record<string, string | null>> = Object.freeze({
  idle1_a: 'idle', idle1_b: 'idle', idle1_c: 'idle', idle1_d: 'idle',
  idle2_a: 'idle', idle2_b: 'idle', idle2_c: 'idle', idle2_d: 'idle', idle2_e: 'idle',
  breath: 'listen', breath2: 'listen', relaxed: 'listen',
  talk2: 'talk', talk3: 'talk', talk_gesture: 'talk',
  work: 'work',
  dance: 'celebrate',
  shadow: 'celebrate',
})

export interface BridgeCapabilities {
  readonly characterId: string
  readonly characters: readonly string[]
  readonly modelSelectable: readonly string[]
  readonly roles?: Readonly<Record<string, readonly string[] | undefined>>
}

export type CapabilitiesResult =
  | { readonly ok: true; readonly capabilities: BridgeCapabilities }
  | { readonly ok: false; readonly error: string }

export type ResolvedAction =
  | { readonly ok: true; readonly action: string | null }
  | { readonly ok: false; readonly error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read-only capabilities fetch: GET /watch/capabilities with the header
 * token over the pinned transport. Never changes bridge or watch state (no
 * state-changing GET, no probe-as-auth). `fetchImpl` defaults to the pinned
 * transport (pin verified pre-token, redirects refused); tests inject a
 * stub. The return type mirrors the bridge's describeCapabilities: only
 * characterId/characters/modelSelectable/roles are consumed — version,
 * features and cappiAction pass through uninterpreted, never fabricated
 * when the bridge is unreachable (failures are errors, not defaults).
 */
export async function fetchCapabilities(
  config: ResolvedWatchConfig,
  fetchImpl?: BridgeFetch,
): Promise<CapabilitiesResult> {
  const checked = checkBridgeUrl(config.bridgeBaseUrl, config.allowInsecureLan, config.bridgeCertPin)
  if (!checked.ok) return { ok: false, error: checked.error }
  let token: string | undefined
  try {
    token = await readBridgeToken(config)
  } catch {
    return { ok: false, error: 'bridge token is unreadable' }
  }
  if (!token) return { ok: false, error: 'bridge token is not configured' }
  const bridgeFetch = fetchImpl ?? createBridgeFetch(config)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const url = new URL(CAPABILITIES_PATH, checked.url).toString()
    const response = await bridgeFetch(url, {
      method: 'GET',
      headers: { [BRIDGE_TOKEN_HEADER]: token },
      body: '',
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => undefined)
    if (!response.ok || !isRecord(payload) || payload.ok !== true) {
      const detail = isRecord(payload) && typeof payload.error === 'string' && payload.error
        ? payload.error
        : `bridge error ${response.status}`
      return { ok: false, error: detail }
    }
    const characterId = typeof payload.characterId === 'string' ? payload.characterId : ''
    const modelSelectable = Array.isArray(payload.modelSelectable)
      ? payload.modelSelectable.filter((id): id is string => typeof id === 'string' && !!id)
      : []
    const characters = Array.isArray(payload.characters)
      ? payload.characters.filter((id): id is string => typeof id === 'string' && !!id)
      : []
    let roles: Readonly<Record<string, readonly string[] | undefined>> | undefined
    if (isRecord(payload.roles)) {
      const table: Record<string, readonly string[]> = {}
      for (const [role, ids] of Object.entries(payload.roles)) {
        if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) table[role] = [...ids]
      }
      roles = table
    }
    if (!characterId || modelSelectable.length === 0) {
      return { ok: false, error: 'bridge returned unusable capabilities' }
    }
    return { ok: true, capabilities: { characterId, characters, modelSelectable, ...(roles ? { roles } : {}) } }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, error: 'bridge request timed out' }
    }
    return { ok: false, error: `bridge request failed: ${error instanceof Error ? error.message || 'network error' : 'network error'}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve one requested action against queried capabilities. `clear`/null
 * always resolves (it carries no capability). A legacy id maps to the first
 * selectable action of its role in the ACTIVE pack; ids with no equivalent
 * or with no role coverage fail closed with the callable list.
 */
export function resolveActionCapability(
  requested: string | null,
  capabilities: BridgeCapabilities,
): ResolvedAction {
  if (requested === null) return { ok: true, action: null }
  if (STATE_OWNED_ACTIONS.includes(requested)) {
    return { ok: false, error: `action '${requested}' is state-owned and not model-requestable` }
  }
  const selectable = capabilities.modelSelectable
  if (selectable.includes(requested)) return { ok: true, action: requested }
  if (Object.hasOwn(LEGACY_CAPPI_ROLE, requested)) {
    const role: string | null = LEGACY_CAPPI_ROLE[requested] ?? null
    if (role === null) {
      return {
        ok: false,
        error: `legacy action '${requested}' has no capability in character '${capabilities.characterId}'; callable: ${selectable.join(', ') || '(none)'}`,
      }
    }
    // Prefer the pack's role table (exact bridge semantics); fall back to a
    // name-prefix guess only when the table is absent (older bridge).
    const selectableSet = new Set<string>(selectable)
    const roleMembers: readonly string[] = capabilities.roles?.[role] ?? []
    const mapped: string | null = roleMembers.find((id: string) => selectableSet.has(id))
      ?? selectable.find((id: string) => id.toLowerCase().startsWith(role))
      ?? null
    if (mapped) return { ok: true, action: mapped }
    return {
      ok: false,
      error: `legacy action '${requested}' (${role}) is unavailable in character '${capabilities.characterId}'; callable: ${selectable.join(', ') || '(none)'}`,
    }
  }
  return {
    ok: false,
    error: `unknown action: ${requested} (character '${capabilities.characterId}'; callable: ${selectable.join(', ') || '(none)'})`,
  }
}
