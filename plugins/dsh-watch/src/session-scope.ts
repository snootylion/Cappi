/**
 * Watch-linked session scope.
 *
 * The character tool acts ONLY in the watch-linked session — the harness
 * session the bridge is bound to. Every other calling session receives
 * `{ ok: false, error: 'not the watch session' }` and nothing is sent to the
 * bridge.
 *
 * Caller identity proof (SDK types, read-only — no runtime vendored):
 * `exec` is a `ToolRunContext` (`@deepseek-ai/dsh-tools`), which extends
 * `ToolExecution`, whose `agent` field is documented "The agent on whose
 * behalf the call runs (set by the agent loop)". `Agent`
 * (`@deepseek-ai/dsh-agent`) is `{ readonly id: SessionId }` where
 * `SessionId` (`@deepseek-ai/dsh-session`) is the harness session brand —
 * the agent handle IS the session identity (also the scope-carrier key in
 * `dsh-agent/dispatch`). So `exec.agent.id` is the calling harness session
 * id by construction, not by assumption. The plugin passes it to the bridge
 * verbatim as `sessionId`; the bridge re-checks it against its watched
 * session atomically before any character effect (TOCTOU guard), so the
 * plugin cannot fake scope even if misconfigured.
 *
 * Integration boundary: the host offers no adapter to resolve "the
 * watch-linked session" from inside a tool (no active-session context API),
 * so the binding stays explicit configuration (`watchSessionId`, env
 * `DSH_WATCH_SESSION_ID`), compared against the proven caller id above.
 * When unconfigured the tool fails closed with a `watch session is not
 * configured` error instead of pretending to be complete. A future adapter
 * could inject the bridge-bound session id as `watchSessionId` at deploy
 * time — no plugin code change needed beyond that wiring, and the bridge's
 * independent check would still apply.
 */

export const NOT_WATCH_SESSION = 'not the watch session'
export const WATCH_SESSION_UNCONFIGURED = 'watch session is not configured: set watchSessionId (env DSH_WATCH_SESSION_ID)'

export type SessionScopeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string }

/**
 * Check that the calling session is the configured watch-linked session.
 *
 * @param callerSessionId - the calling agent's session id (`exec.agent?.id`).
 * @param watchSessionId - configured watch-linked session id, if any.
 */
export function checkWatchSessionScope(
  callerSessionId: string | undefined,
  watchSessionId: string | undefined,
): SessionScopeResult {
  const watch = watchSessionId?.trim()
  if (!watch) return { ok: false, error: WATCH_SESSION_UNCONFIGURED }
  if (!callerSessionId || callerSessionId !== watch) {
    return { ok: false, error: NOT_WATCH_SESSION }
  }
  return { ok: true }
}
