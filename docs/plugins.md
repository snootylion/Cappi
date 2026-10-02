# Plugins (contributor D owns)

Two DSH plugins ship as source in `plugins/`. Both install from this tree
into isolated roots for review; **no installer here ever touches a live DSH
profile, and no installer runs against the live environment.** See each
plugin's README for its own config reference.

## Safety rules (all installers)

- **Dry-run by default.** Every script under `plugins/*/resources/` prints
  its plan and exits 0 until `--apply` is passed.
- **Portable paths.** `DSH_HOME` (`--dsh-home`), profile (`--profile`),
  runtime roots (`--runtime-root`), and executable paths are configurable.
  No personal home directories or absolute tool paths are embedded.
- **Live refusal.** Mutating an existing live target additionally requires
  `--allow-live` **and** `DSH_WATCH_MAINTENANCE_CONFIRM=1` (an explicit
  outside-session maintenance confirmation; never set by automation).
- **Model opt-in.** TTS/summary model assets download only with explicit
  `--download-models`. Revisions, checksums, and license notes are documented
  per plugin; no weights are vendored in this tree.
- **Separate source and runtime artifacts.** The allowlisted source export
  excludes compiled helpers/build outputs. Runtime npm tgz packages include
  prebuilt `lib/` assets and the manifest-verified native watch-ASR helper.
  Weights, credentials, logs, personal preferences, consent/state, keystores,
  native privacy data and caches never ship. Local artifact review does not
  authorize publication or deployment.

## Normal managed installation

Use vanilla DSH 0.1.2-rc.1 and Node 22.19+. Install **LiveVoice first, then
Cappi**, using the official CLI (not a user wrapper):

```sh
dsh plugin --profile web add /path/to/dsh-live-voice-kokoro-0.3.0-rc0.tgz
dsh plugin --profile web add /path/to/dsh-watch-0.3.0-rc0.tgz
```

Start your normal web profile, open authenticated Settings → Watch, consent to
voice setup, compare both fingerprints and approve the watch wizard. Select a
thread using the watch UI; no manual services, tokens or session IDs are needed.
Real model-provider configuration and normal first-user OS permissions remain
prerequisites. The plain-language installation steps are in the repository
`README.md`; this document is the technical plugin reference.

## dsh-live-voice — local live voice

Source in `plugins/dsh-live-voice/` (see its README and PROVENANCE).
On-device Apple Speech capture, Kokoro/Pocket TTS, contextual holding
phrases, and private continuation summaries, preserving validated behavior:

- Voice ownership: one server-side input lease binds a browser surface, a
  lease generation, and one harness session. Transcripts and summary events
  go to the lease owner only.
- Draft-only dictation: STT-only dictation writes composer drafts; it never
  auto-prompts.
- Assistant streaming summaries: the first sentences speak eagerly while the
  finalized remainder is summarized privately; cancellation and barge-in
  settle safely; warm workers are reused.

Defaults (locale, voices, providers, models, paths) are centralized in
`src/voice-defaults.ts` and overridable via plugin config or environment.
Host support is reported by status, not assumed from installation. The watch
ASR runtime helper is universal arm64+x86_64, ad-hoc signed, and targets macOS
13+; it installs prebuilt without CLT. Building source requires macOS SDK/CLT.
Native execution is tested on the available Apple-silicon host; Intel has a
compiled slice, not an actual Intel execution claim. Normal first-user Speech
consent remains required; already-authorized diagnostics do not prompt or capture.
Mac input and optional model-backed TTS/summary features have their own readiness
and permission prerequisites. The harness-LLM summary backend remains opt-in.

Installers (review first, dry-run first):

```bash
./resources/install-live-voice-runtime.sh --apply --download-models
./resources/install-mlx-summary.sh --apply --download-models
./resources/deploy-profile-plugin.sh --apply
```

## dsh-watch — turnkey watch link (self-contained, in-process default)

Source in `plugins/dsh-watch/` (see its README and PROVENANCE). Version
`0.3.0-rc0`. Default `bridgeMode: "managed"` (empty config activates fully
when the LiveVoice `liveVoiceWatch` service is present): one `ctx.effect`-
disposed runtime per profile — ephemeral HTTPS LAN server (never the DSH web
port, never a fixed default), pairing service (`GET /pair/info`,
`POST /pair/enroll`, `POST /pair/poll` per `protocol/turnkey.schema.json`
and `docs/TURNKEY-CONTRACT.md` §§8–9), per-device token store + session-
binding resolver (`GET /watch/binding`), full watch endpoints
(`health/stream/state/capabilities/image/mic/command/cappi/pair-probe` +
session queue/approvals/models/questions/audio outputs/speech chunks ported
from the legacy standalone bridge), and binding-checked Cappi tools. Inject
is exactly
`['tools','sessionController','workspaceController','webServer','connection',
'liveVoiceWatch','permissionPresets']` (host consumes `liveVoiceWatch`; voice provides it).

- **Automatic session binding, no manual session IDs.** The watch UI stays
  the session authority (`select-session` pin / auto-follow); every tool call
  checks `exec.agent.id` against the binding for THAT device atomically
  (missing → 400, none watched → 409, mismatch → 409 with no effect).
  Static `watchSessionId` is an optional override only (fail-closed when both
  absent; logged on disagreement). No `watchSessionId`/token/env required in
  the default config, and Cappi tools never prompt.
- **Pairing (exact, no invented crypto).** TLS cert pin (`sha256/` + base64 of
  32 bytes, constant-time) + dual fingerprint compare (FULL + 96-bit short;
  never a 6-digit code) + client CSPRNG enrollment secret (single-use) +
  trusted-UI approval (`fingerprintConfirmed:true`). Pending TTL max 2 min,
  bounded map, per-IP rate limit, `?token=` rejected 401, poll secret
  constant-time + single-use atomic. The server never claims a "pinned client
  channel": the WATCH verifies the handshake cert — documented client
  responsibility. State persists outside the package
  (`<actual-profile-root>/dsh-watch/turnkey/`, resolved from public Cordis
  `ctx.baseUrl` for the loaded profile; stable cert + tokens + bindings,
  0600/0700); certs generate at startup via the platform-standard
  `openssl` tool (no forced Xcode, no quiet plaintext LAN).
- **Auth split.** DSH-admin routes (`GET /admin/pair/status`,
  `POST /admin/pair/approval`, `POST /pair/deny`, same DSH origin) call
  `ctx.connection.requestRejection({ headers })` and honor 401/403. Watch LAN
  routes use pinned TLS + per-device `X-Bridge-Token` only — never the DSH
  browser cookie. No `~/.dsh` credential reads, no cookie minting.
- **Audio/TTS/mic.** `POST /watch/mic/start` preflights (200 ready only after
  the V backend is ready, else 503 `mic-not-ready`); chunked
  `POST /watch/mic?streamId=` buffers pre-ready frames (never discarded),
  rejects stale generations, and acknowledges the EOF final drain with a
  bounded receipt (`txChunks/txBytes/ackFinals` + `utteranceId` exactly-once).
  TTS streams via the V chunk callback with explicit
  `sampleRate`/`channels`. Binding/mic timeouts and direct-submit errors
  propagate (`{ code, message, retryable }`, never unobserved void); agent
  `running` state is never reset falsely (watchdog demotes indicators only).
- **Characters (payload discipline).** Only needed metadata ships in-tar
  (registry subset + selected-pack descriptors in `src/character-payload.ts`,
  version `0.3.0-rc0`); no GIF bytes, no weights, no `../../runtime`
  references. State-owned cues (`question`, `static_hold`, …) never resolve.
- **Advanced legacy path.** `bridgeMode: "legacy"` keeps the explicit
  out-of-process bridge (`bridgeBaseUrl` + token + pin) for fixtures/tests;
  honest, never default. The standalone `bridge/*.mjs` source remains an
  optional historical adapter in the source export, not a dependency of the
  managed runtime. Its fixed-port/cookie behavior does not describe managed mode.
- **One active watch per profile (0.3.0-rc0).** Revoke/unpair before replacement;
  additional enrollment must refuse while an active device exists. Binding,
  certificate, consent and queue scope follow the actual advertised service
  contract, not an invented multi-device guarantee.
- **Explicit SDK limits.** Managed `features.queueReorder:false` reflects the
  missing rc.1 reorder API; the watch disables that control, and unsupported
  calls refuse rather than reporting fake success. Do not claim blanket legacy
  feature parity.
- **Client.** Mac Settings UI via real `dsh.client` web hooks
  (`src/client/`: certificate compare confirmation, pending Approve/Reject,
  revocation, backend readiness + Setup consent calling the V service). No
  standalone-port admin web.
- Supported runtime: Node.js 22.19+ / 24 / 26 (peers `0.1.2-rc.1`).
