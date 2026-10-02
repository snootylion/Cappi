/**
 * Minimal bridge client for `POST /watch/cappi`.
 *
 * Transport contract (follows bridge C's pinned HTTPS / header-token rules):
 *
 * - The token travels ONLY in the `X-Bridge-Token` header, never in the URL.
 * - The default target is loopback `https://127.0.0.1:8787` (the bridge
 *   secure default); `https:` targets require the pinned certificate
 *   (`bridgeCertPin`, same DER-SHA256 convention as the watch) verified
 *   pre-token — fail-closed with no token sent until the pin is configured.
 *   Explicit loopback `http:` stays allowed for local fixtures;
 *   non-loopback `http:` requires the explicit `allowInsecureLan` opt-in.
 *   No silent downgrade, no redirects (refused), no token in URLs (refused
 *   before any byte is sent).
 * - The caller's harness session id travels in the POST body (`sessionId`)
 *   so the bridge can enforce the watched-session match atomically before
 *   any character effect. The plugin never fakes it: the handler passes
 *   `exec.agent.id` through verbatim.
 * - Token values never appear in errors, logs, or results.
 * - All network failures surface as `{ ok: false, error }` — never thrown —
 *   so the model gets a usable tool result instead of a host exception.
 */

import { readFile } from 'node:fs/promises'
import { checkBridgeUrl, type ResolvedWatchConfig } from './config.ts'
import { BRIDGE_TOKEN_HEADER, createBridgeFetch, type BridgeFetch } from './pinned-fetch.ts'

export { BRIDGE_TOKEN_HEADER, type BridgeFetch, type BridgeResponse } from './pinned-fetch.ts'

export const WATCH_CAPPI_PATH = '/watch/cappi'

/** Read the bridge token: explicit value wins, otherwise the token file. */
export async function readBridgeToken(config: ResolvedWatchConfig): Promise<string | undefined> {
  if (config.bridgeToken) return config.bridgeToken
  try {
    const raw = await readFile(config.bridgeTokenPath, 'utf8')
    const token = raw.trim()
    return token || undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export type BridgeActionResult =
  | { readonly ok: true; readonly action: string | null }
  | { readonly ok: false; readonly error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * POST one resolved action to the bridge. `action` must already be resolved
 * against queried capabilities (a selectable id or null for clear);
 * `sessionId` is the calling harness session id (`exec.agent.id` verbatim)
 * for the bridge's atomic watched-session match. `fetchImpl` defaults to the
 * pinned transport; tests inject a stub. Never prompts, never autosubmits,
 * never touches harness session state — the only side effect is the bridge
 * POST (a single non-redirected request; token in the header only).
 */
export async function postWatchAction(
  config: ResolvedWatchConfig,
  action: string | null,
  sessionId: string,
  fetchImpl?: BridgeFetch,
): Promise<BridgeActionResult> {
  const checked = checkBridgeUrl(config.bridgeBaseUrl, config.allowInsecureLan, config.bridgeCertPin)
  if (!checked.ok) return { ok: false, error: checked.error }
  if (typeof sessionId !== 'string' || !sessionId) {
    return { ok: false, error: 'calling session id is required for the bridge session binding' }
  }
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
    const url = new URL(WATCH_CAPPI_PATH, checked.url).toString()
    const response = await bridgeFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [BRIDGE_TOKEN_HEADER]: token,
      },
      body: JSON.stringify({ action, sessionId }),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => undefined)
    if (!response.ok || !isRecord(payload)) {
      return { ok: false, error: bridgeError(response.status, payload) }
    }
    if (payload.ok !== true) {
      return { ok: false, error: typeof payload.error === 'string' && payload.error ? payload.error : `bridge error ${response.status}` }
    }
    const returned = payload.action === null || payload.action === undefined ? null : payload.action
    if (returned !== null && (typeof returned !== 'string' || returned !== action)) {
      return { ok: false, error: 'bridge returned an unexpected action' }
    }
    return { ok: true, action: returned }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, error: 'bridge request timed out' }
    }
    return { ok: false, error: `bridge request failed: ${safeMessage(error)}` }
  } finally {
    clearTimeout(timer)
  }
}

function bridgeError(status: number, payload: unknown): string {
  if (isRecord(payload) && typeof payload.error === 'string' && payload.error) {
    return payload.error
  }
  if (status === 401) return 'bridge rejected the token'
  if (status === 404) return 'bridge has no /watch/cappi route'
  return `bridge error ${status}`
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message || 'network error'
  return 'network error'
}
