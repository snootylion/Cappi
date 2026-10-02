# dsh-watch provenance

## Sources

- Tool contract: `plugins/dsh-watch/CONTRACT-DRAFT.reference.md` (the
  `cappi_action` draft: allowlisted actions, watch-linked session scope,
  bridge token from local config, `POST /watch/cappi`). The draft's
  behavior is preserved; only its personal config path
  (`dsh-watch/bridge/token` under the author's home) became the portable
  `bridgeTokenPath` default.
- Action vocabulary: the single source of callable actions is the canonical
  `characters/registry.json`, bound bridge-side by `bridge/characters.mjs`
  and consumed here dynamically via authenticated `GET /watch/capabilities`
  (the active pack's `model_selectable` list; the bridge re-resolves every
  `POST /watch/cappi` authoritatively). The frozen 18-id legacy vocabulary
  (`bridge/cappi.mjs` `CAPPI_ALLOWLIST`, `clear → null`) survives only as a
  backward alias resolved per active pack (`LEGACY_CAPPI_ROLE`, mirrored
  fail-fast in `src/capabilities.ts` — early refusal only, never wider).
  The deprecated `CAPPI_ALLOWLIST` re-export in `src/cappi-actions.ts` is a
  documentation hint kept for existing imports; the handler never consults
  it, and no pack-specific list is hardcoded on the production path.
- DSH registration API: sourced **read-only from the installed SDK's
  `.d.ts` types** (`@deepseek-ai/dsh-tools` `defineTool`/`ToolRunContext`,
  `@deepseek-ai/dsh-agent` `Agent.id: SessionId`, `@deepseek-ai/cordis`
  `Context`, `@deepseek-ai/schemastery` config schema). No SDK runtime code
  is vendored; the host provides it. Pinned versions are in `package.json`.

## Caller-session context (proven, not assumed)

`exec.agent.id` IS the calling harness session id — established read-only
from the installed SDK's `.d.ts` types (pinned versions in `package.json`;
no SDK runtime vendored, no credentials read):

- `@deepseek-ai/dsh-session` `lib/types/types.d.ts`: `SessionId` is a
  branded string (`Branded<'SessionId'>`) — the harness session identity.
- `@deepseek-ai/dsh-agent` `lib/types/types.d.ts`: `Agent` is
  `{ readonly id: SessionId }`, registered as `TypertLookup<Agent,
  SessionId>` / `TypertContext<SessionId>` — the agent handle IS the
  session identity (also the scope-carrier key; see `dsh-agent/dispatch`).
- `@deepseek-ai/dsh-tools` `lib/types/index.d.ts`: `ToolRunContext extends
  ToolExecution`, whose `agent` field is documented "The agent on whose
  behalf the call runs (set by the agent loop)".

The plugin therefore reads `exec.agent.id` verbatim as the caller session,
compares it against the explicit `watchSessionId` binding (fail-closed when
empty), and forwards it UNCHANGED as `sessionId` in the `POST /watch/cappi`
body. The bridge re-checks that value against its watched session
atomically before any character effect (`bridge/session-binding.mjs`,
TOCTOU guard), so scope cannot be faked from the plugin side even if
misconfigured. Proven by `tests/registration.spec.ts` (real `defineTool`
registration driven with mock `exec` identities + stubbed transport,
asserting the forwarded `sessionId` and the no-call refusal path).

## No active-session context API (integration boundary)

No stable host API lets a tool plugin resolve "the watch-linked session" on
its own (the agent loop owns session binding). The watch-linked session is
therefore explicit configuration (`watchSessionId`, env
`DSH_WATCH_SESSION_ID`) compared against the proven caller id above, and
the bridge enforces the match independently. Until the harness offers such
an API, this stays explicit and fails closed. A future adapter could resolve
the bridge-bound session id and inject it as `watchSessionId` at deploy
time — no plugin code change needed beyond that wiring. No unsupported
adapter is called (see the no-prompt/no-session-state regression test:
`SessionFace`, `sessionController`, `.prompt(`, `createUserMessage`,
`ctx.llm`, `run_code`, `answerApproval` appear in no source module).

## Licenses

- All files under `plugins/dsh-watch/src/`, `tests/`, and these docs are
  original to this release tree and are licensed under Apache-2.0 (see
  `LICENSE`; notices in `NOTICE.md`; the grant is recorded in the root
  `LICENSE-DECISION.md`).
- No upstream license is claimed or invented here: the DSH SDK packages are
  peer/dev dependencies resolved from the package registry at build time,
  not vendored. Their terms apply to their own artifacts.
