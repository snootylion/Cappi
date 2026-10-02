# dsh-watch — watch-linked character tool

A DSH host plugin that lets the model request character avatar actions on
the watch. It registers two names for one handler:

- `cappi_action` (primary; the contract-draft name), and
- `watch_cappi` (alias; the namespaced form).

## Turnkey default (managed)

Install with the live-voice companion; normal managed configuration is empty.
Pair in DSH Settings, compare the certificate fingerprint, approve the watch,
and choose or create a real harness session. No copied token, environment
variable, Mac microphone lease, or pre-existing session is required.

- HTTPS uses a dynamic port and a stable certificate stored under the actual
  Cordis profile root (`<DSH_HOME>/profiles/<profile>/dsh-watch/turnkey` in vanilla
  DSH). Profile identity comes from the public `ctx.baseUrl`, measured on rc1;
  it is not inferred from package paths or an invented profile environment variable.
  Advanced `dshHome` explicitly overrides that private state root.
- **One active watch per profile.** Approval reserves the only slot; polling
  rechecks it. A second approval returns 409 until the old watch is explicitly
  revoked (or its pending reservation denied/expired). There is no silent revoke
  and no second authorized watch sharing queue/question state.
- The default UDP discovery listener chooses the first available port in
  **8788–8797**. Exhaustion fails with an actionable error, never an unreachable
  random fallback. An explicit custom port is honored, but outside this range
  requires manual host entry. HTTPS port changes do not change the stored pin.
- macOS uses its built-in `/usr/bin/openssl`; normal installation does not need
  an additional certificate tool or runtime compiler. Missing platform tools,
  incomplete identity files, symlink paths, permission failures, and corrupt
  private JSON fail closed. Corrupt data never silently resets pairing/authentication.
  Private directories/files are verified 0700/0600; writes use exclusive unique
  staging files, fsync, atomic rename, and last-committed-state rollback.
- `start`/`stop`/`mute` own the watch transport only: no automatic Mac capture.
  Authenticated mic preflight awaits the actual voice input. A deliberate new
  recording cancels watch audio output only, not a running harness turn.
- Normal mic-off closes PCM and awaits the terminal ASR receipt. Force-abort
  uses authenticated `mic-cancel` with the exact capture `streamId`, advertised
  by `features.micCancel:true`; legacy absence means unsupported, never a
  fallback to cancelling the model. It disposes only that owned input (including
  ready-before-upload or pending native readiness), leaves voice/TTS/follow
  untouched, and is idempotent for absent/closed IDs. Cancellation intents are
  bounded and short-lived; use a fresh stream ID for the next capture.

### Actual rc1 host APIs and truthful limits

Session creation uses `sessionController.create({workspaceId})` or `{cwd}`
(not both). Failure never returns a made-up local session ID. Prompt/steer use
real request IDs and typed text content; queue remove/steer use actual
`updateQueue` occurrences and acknowledge only after the host accepts.

Model choices expose the watch's canonical `options/currentValue` wire and
map opaque `modelId` values back to the current provider/model catalog.
Reasoning is part of a real model selection. Permissions use the actual
`permissionPresets` owner and the bound agent's Session, not a guessed method
on the Session controller. Live queue/jobs/todos/model/permission/workspace
state is emitted at the watch's direct snapshot keys.

Questions and approvals attach to the real scoped Cordis
`user-questions/request` / `approval/request` waterfalls. The Mac and watch
can answer the same request; only the first result wins. The watch correlation
ID owns that exact pending promise (rc1 callbacks carry no remote event ID).
Answers echo original question IDs/option labels; question dictation is
**draft-only** and never becomes a prompt or approval automatically.

`open-mac` uses the real host native opener only when available. URLs must be
credential-free HTTP(S). Images come solely from the bound Session attachment
API, with bounded raster MIME/magic validation and private staging; arbitrary
file paths and executable URL schemes are never accepted.

rc1 has **no queue reorder operation**. `queue-move` returns 501; initial SSE,
`/watch/state`, `/watch/health` and `/watch/capabilities` publish
`features.queueReorder: false` so the watch disables it. `features.openMac`
reflects the actual host native opener. Other missing optional host APIs return
truthful unavailable errors, not fabricated success. No absent Session method
is treated as evidence that every other SDK domain is absent.

## Advanced legacy session scope (explicit, proven, re-checked bridge-side)

The tool acts **only in the configured watch-linked session**
(`watchSessionId`, env `DSH_WATCH_SESSION_ID`). The caller identity is
`exec.agent.id`, which the SDK types prove IS the calling harness session id
(`Agent.id: SessionId`, set by the agent loop — see PROVENANCE.md). Any other
calling session — or an unconfigured plugin — receives
`{ ok: false, error: 'not the watch session' }` (or a
`watch session is not configured` error) and **no bridge call is made**.
The caller id is then forwarded verbatim as `sessionId` in the bridge POST,
and the bridge enforces the watched-session match atomically before any
character effect, so scope cannot be faked from the plugin side.

## Actions (bridge capabilities, validated, session-bound)

- `{ action: string }`, or `"clear"` (null) to resume the auto schedule.
  Callable actions come from the bridge's authenticated
  `GET /watch/capabilities` (active pack's `model_selectable`, derived from
  the canonical `characters/registry.json`); legacy `/watch/cappi` ids map
  to pack roles automatically. State-owned cues (`question`, `static_hold`)
  are never model-requestable. Unknown actions and missing capabilities are
  refused with the callable list; nothing invents assets or URLs.
- With `manifestPath` set, the action must additionally satisfy the local
  manifest gate (extra fail-closed constraint for staged rollouts); unset by
  default, in which case the bridge capabilities alone decide. Malformed
  manifests fail closed.
- The tool never invents assets/URLs and never forges pending/question
  state: pending items are surfaced by the harness, not faked. It never
  prompts, steers, or autosubmits (regression-tested). The only
  state-changing request is the final `POST /watch/cappi`; the capabilities
  GET is read-only (no state-changing probe requests).

## Advanced legacy bridge link (header token, pinned HTTPS)

- `POST {bridgeBaseUrl}/watch/cappi` with `{ action, sessionId }` and the
  token in the `X-Bridge-Token` header only — never in the URL (see
  `docs/connection-security.md`). (The watch SSE route is
  `GET /watch/stream`.)
- Default `https://127.0.0.1:8787` (the bridge secure default: HTTPS only).
  Pairing: copy the `sha256/…` pin the bridge prints at startup into
  `bridgeCertPin` (env `DSH_WATCH_BRIDGE_PIN`) before any token is sent —
  `https:` targets verify the pinned bridge certificate SHA-256 (same
  DER-SHA256 convention as the watch) during the handshake, fail-closed
  with no system-PKI fallback and no downgrade. Without the pin the plugin
  refuses before any byte is sent. Explicit loopback `http:` stays allowed
  for local review fixtures; non-loopback `http:` requires the explicit
  `allowInsecureLan` opt-in. Redirects are refused, never followed.
- Token sources: `bridgeToken` value, else the mode-600 file at
  `bridgeTokenPath` (default `<DSH_HOME>/dsh-watch/bridge/token`).
  Token values never appear in errors or logs.
- Timeouts and network failures return `{ ok: false, error }` results.

## Advanced legacy configuration

| Field | Env | Default |
|---|---|---|
| `bridgeBaseUrl` | `DSH_WATCH_BRIDGE_URL` | `https://127.0.0.1:8787` |
| `bridgeToken` | `DSH_WATCH_BRIDGE_TOKEN` | (unset; test/CI fixtures) |
| `bridgeTokenPath` | `DSH_WATCH_BRIDGE_TOKEN_PATH` | `<DSH_HOME>/dsh-watch/bridge/token` |
| `bridgeCertPin` | `DSH_WATCH_BRIDGE_PIN` | (unset; required for `https:` targets) |
| `watchSessionId` | `DSH_WATCH_SESSION_ID` | `""` (fails closed) |
| `manifestPath` | `DSH_WATCH_MANIFEST_PATH` | (unset) |
| `allowInsecureLan` | `DSH_WATCH_ALLOW_INSECURE_LAN` | `false` |
| `timeoutMs` | `DSH_WATCH_TIMEOUT_MS` | `8000` (1000–30000) |

See `cordis.patch.yml` for a deployment snippet.

## Companion skill (optional)

`SKILL.md` holds generic reply-style instructions for the watch-linked
conversation only (short, glanceable replies; progress updates; real tool
calls; no invented UI). It is optional and scoped: it never applies to other
sessions.

## Build and test (isolated, no live harness)

```bash
npx --yes pnpm@10.15.1 install
npx --yes pnpm@10.15.1 run check
# ...or step by step in clean order (build before test):
# npx --yes pnpm@10.15.1 run typecheck
# npx --yes pnpm@10.15.1 run build
# npx --yes pnpm@10.15.1 run test
```

Build asserts the bundled character metadata exactly matches the public registry
and package version; the published runtime reads no outside registry path.

Tests use mocks, physical temp roots, and injected ephemeral/private UDP and
TCP ports only (never production discovery ports). Nothing
here modifies a live DSH installation or restarts the harness.

## License / provenance

Source in this directory is original to this release tree except as noted
in PROVENANCE.md, and is licensed under Apache-2.0 (see `LICENSE`;
notices in `NOTICE.md`). No model weights, tokens, or credentials ship here.
DSH SDK packages are registry-resolved peer/dev dependencies under their
own terms — nothing about them is relicensed here. Nothing here is published
from this tree; installable packs are local-only build outputs.
