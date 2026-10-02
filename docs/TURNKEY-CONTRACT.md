# TURNKEY CONTRACT — vanillaMacDSH install → LiveVoice → Cappi → guided pairing

- Status: implemented transport reference for the 0.3.0-rc0 local review candidate. Historical vanilla probes are distinguished from current acceptance evidence; this document is not a hardware/UI certification.
- Scope: `web` profile only. Vanilla = installed `@deepseek-ai/dsh@0.1.2-rc.1` via its real
  package JS entry (see installer manifest; NOT a user-env launcher shim).
- Node: accepted support target 22.19+; CI builds on 22.19.0 and 26. Runtime support is proved by the complete actual-runtime acceptance leg, never a version probe.
- Normative DTOs: `protocol/turnkey.schema.json` (draft-07, `$id`
  `https://dev.dsh.watch/protocol/turnkey.schema.json`).
- Evidence: `tools/test-vanilla-install.sh` uses an isolated keyless vanilla boot,
  private temp home and ephemeral ports. Generated-speech native recognition,
  fixture-model host replies, production TTS and scoped registered Cappi tool
  execution are separate from real external-provider and physical-watch claims.
- Publication/upload/deployment remains unauthorized; local checks do not grant it.

## 0. Components and boundaries

The managed host plugin owns pairing, profile-scoped state, session controls and
Cappi tools. LiveVoice provides the injected audio service. The watch app owns the
normal pairing wizard and fingerprint comparison. Release tools own reproducible
source/runtime inventories and acceptance. There is no production ADB provisioning
receiver requirement; ADB is merely an optional user installation/test transport.

## 1. Vanilla SDK facts and API requirements

1.1 Install entry (PROVEN): the ONLY supported install is
`dsh plugin --profile <name> add <file-or-registry-spec>` (forwards to pnpm in the
profile dir, then reconciles `dsh.bundle.patch` into `dsh.profile.bundles`). Measured exit 0
for both a scratch probe package and `dist/dsh-watch-0.2.0-rc0.tgz` into a temp profile.
Direct `node_modules` copies / hand-edited `bundles` arrays are NOT supported.

1.2 Keyless ephemeral boot (PROVEN): `web` boots with NO credentials on an OS-assigned port
(`-- --port 0 --no-open`; ephemeral port — never a fixed default).
Unauthenticated `GET /` and `GET /api/` return `401 unauthorized`. The temp home gains only
`.anonymous-user-id`, a skeletal `.credentials.yaml`, `profiles/`, `storages/`.

1.3 `sessionController` / `workspaceController` / `webServer` / `connection` exist ONLY in
the `web` composition (`dsh-web-app/cordis.patch.yml` rows `session-controller`,
`settings-controller`, `workspace-controller`, `webserver`, `web-runtime`, `connection`,
`api-remotes`). They are ABSENT from `dsh-base`, `headless`, `sdk`, `sdk-minimal`.
Installer MUST refuse (clear message) on non-web profiles unless it ships its own composition
(which is then not "vanilla").

1.4 DI-before-apply is enforced (PROVEN as possible mechanism, NOT proven historical root
cause): reading `ctx.<service>` without that key in the
plugin's `export const inject` throws at apply time:
`failed to apply loader entry …: cannot get property "connection" without inject`
(measured with a probe that injected `webServer/sessionController/tools` but read
`ctx.connection`). This missing-`inject` probe proves ONE possible mechanism for the
historical `sessionController unavailable` class of failure: out-of-process shape /
missing `inject` entry / wrong profile — NOT an auth failure. It does NOT prove the
actual root cause of the historical external-bridge incident — do not present cause-proven.
Fix is always explicit `inject` + web-profile
scope. Every turnkey plugin MUST list each host service it touches in `inject`.

1.5 Service registration works (PROVEN): a probe with
`inject = ['webServer','sessionController','tools','connection']` loaded on vanilla `web`,
registered `GET /watch-bridge/__probe__` via `ctx.webServer.register({kind:'exact',…})`
with `ctx.effect` disposer, and answered. `ctx.sessionController` and `ctx.tools` were
present (non-null) at apply time.

1.6 Auth seam split (PROVEN + SPEC): `webServer.register` handlers own the full
response and BYPASS the browser-session gate unless they call it. The official gate is
`ctx.connection.requestRejection({ headers })` → `401 | 403 | undefined`
(`dsh-client-connection/lib/types/rpc.d.ts`, `rpc-host.d.ts`: "Apply Connection's
Host/Origin fence, then browser authentication"). PROVEN: probe route calling it returns 401
unauthenticated, identical to `/`. SPEC (mandatory split — the old blanket
"every H HTTPS route MUST call requestRejection" is SUPERSEDED and INCORRECT for watch):
(a) Admin/DSH-settings routes (Mac trusted Settings UI surface) MUST call
`requestRejection` first and honor 401/403. Host/Origin checks alone are
insufficient (localhost malicious-origin CSRF); browser-IP is not authentication.
(b) Watch HTTPS routes (LAN device surface: `GET /pair/info`, `POST /pair/enroll`,
`POST /pair/poll`, `POST /watch/mic/start`, `POST /watch/mic`, device-bearer
`GET /watch/binding`, `GET /watch/health`) MUST use per-device auth — pinned TLS +
`enrollmentSecret` (pairing) / per-device token in `X-Bridge-Token` header (post-pair) —
and MUST NOT require the DSH browser cookie/session (otherwise the watch is unusable:
it holds no browser cookie). CORS/cookie headers on these routes are rejected via the
connection gate, never accepted as auth.
Preferred alternatives that inherit auth automatically: `ctx.connection.fetch.register`
(exact `GET|HEAD` Fetch routes below `/api`) or `ctx.connection.rpc.handle/intercept`
(authenticated logical channels); custom business APIs SHOULD be a `TypertRemoteService`
subclass (`bindTypertRemote(this, serviceKey)` + `@Remote` methods, same pattern as
`SessionController extends TypertRemoteService` → generated `ctx.remote.session` namespace;
client then calls the generated `ctx.remote.<namespace>` instead of hand-rolled fetch).

1.7 SDK/runtime pins: the two current plugin manifests and lockfiles use published
`0.1.2-rc.1` SDK packages and Node 22.19+ floors. Earlier alpha.2/26-only drift is
historical, not a current installation caveat. The acceptance script rejects CLI
version drift and prints the real runtime used by CLI/install/boot/pnpm descendants.

## 2. Managed runtime lifecycle

- H owns, in-process, exactly ONE `ctx.effect`-disposed runtime per DSH profile: the HTTPS
  server (separate ephemeral/auto port, NOT the DSH web port), the pairing service, the
  device-token store, the session-binding resolver, the Cappi tools. One server per DSH
  profile; lifecycle bound to the profile fiber (SIGTERM → `fiber.dispose()` → single
  runtime stop). No standalone bridge process by default; no LaunchAgent plist unless the
  user passes an explicit persistent opt-in. The legacy `bridge/*.mjs` standalone server
  remains optional historical source in the allowlisted source archive, not a managed
  runtime dependency. Managed mode must not read `~/.dsh/.credentials.yaml`, must not mint browser-session
  cookies, must not accept `--token` on the command line or in logs.
- V owns the injected audio service: sink registration, ASR/TTS backend setup, readiness
  state machine (`warming | ready | capturing | closed | error` per stream), and the managed
  warm/release helper. V exposes the service; H consumes it for watch-mic sinks. V never
  auto-acquires the microphone: capture starts only on explicit user tap (watch record pill
  / Mac consent), and release never contradicts an active user intent.
- The watch pairing wizard persists private connection state, compares the actual
  certificate fingerprint, and exposes actionable errors. No production
  `ProvisionReceiver` or manual token provisioning is required.
- Source exports exclude built helpers; runtime tgz packages include compiled
  universal helpers plus exact source/plist/binary hash provenance. No weights,
  private keys, credentials, user preferences or runtime consent/state ship.
- One active watch per profile is supported; revoke before replacement. Managed
  host state is rooted at the actual profile directory resolved from public Cordis
  `ctx.baseUrl` (or an explicit private root), not guessed profile environment names.
  LiveVoice watch Speech consent is a separate private machine/DSH-home setting;
  it does not imply Mac microphone consent or a per-profile OS authorization grant.

## 3. Pairing protocol (exact, no invented cryptography)

Principles: discovery is UNTRUSTED (liveness only, existing 512 B / nonce-regex / port /
≤8-reply bounds kept). No silent TOFU. No plain 6-digit HMAC "pairing" (offline
dictionary-attackable, relay-forwardable — explicitly rejected). No ADB dependency for the
normal pair (ADB is an optional provisioning transport only). No custom ECDH/PAKE/KDF
invention: the only cryptographic primitives are TLS server-certificate pinning (SHA-256 of
DER, `sha256/` base64 of exactly 32 bytes, constant-time compare — already implemented both
ends: `SecureTransport` / `pinned-fetch.ts` / `bridge/tls.mjs`) and a high-entropy random
enrollment secret generated by the watch (client) via a platform CSPRNG.

States (authoritative enum in schema: `unpaired | cert-offered | trust-pending |
enrollment-pending | enrolled | failed-closed`):

3.1 Watch starts `unpaired` (blank base = unpaired; never dials placeholders such as
`192.0.2.1`). Discovery yields untrusted candidates only; no token/audio/secret is sent to
an unverified candidate.

3.2 Provisional cert retrieval (SPEC, exact): watch issues `GET /pair/info` over HTTPS to the candidate
with pinning DISABLED for this one endpoint, retrieving CERT ONLY — no auth, no user
content, no token, no enrollment secret on this request. Server returns
`{ pairProtocol: "turnkey/1", certSha256Pin, serverDisplayName, nonce, fingerprint }`
(shape: schema `pairInfo`; all sample values synthetic). The watch MUST derive the
provisional fingerprint from the ACTUAL TLS handshake certificate seen by the platform
(Android TLS stack), NOT by trusting the response `certSha256Pin` field. The response
`certSha256Pin` is a BIND assertion only: the watch requires byte-equality between
response `certSha256Pin` and the handshake-derived pin; mismatch → `trust-mismatch`,
fail-closed (nothing persisted). Either fingerprint display is derived from the
handshake cert. No auto-TOFU: equality alone never pins — explicit dual confirmation
(§3.3) is still required. The watch
computes the SHA-256 fingerprint and displays it; the trusted Mac DSH Settings UI
(authenticated via §1.6(a) seam) displays the same fingerprint. Display format: FULL
fingerprint, or at minimum 96-bit / 6 groups of 4 hex (e.g. `a1b2-c3d4-…`); a 6-digit SAS
is MISLEADING here and MUST NOT be used for the cert comparison. (If full-compare proves
too burdensome in usability testing, a future revision MAY offer 6 known-word / 128-bit SAS
from an externally-licensed wordlist — never a handcrafted list — as an addition, not a
replacement, with the full fingerprint one tap away.) No URL secrets: `GET /pair/info`
carries no query auth; `?token=` anywhere is rejected 401.

3.3 Explicit dual confirmation of the fingerprint (BEFORE enroll, immutable capture):
the user compares watch display vs Mac
Settings display and confirms ON BOTH (watch Confirm pill + Mac authenticated `yes`
with `fingerprintConfirmed:true` — see §8.4). Fingerprint confirmation MUST precede
`POST /pair/enroll`. On confirm, the watch captures `{ baseUrl, certSha256Pin }` as an
IMMUTABLE pairing record (not a readonly-view mutation: later edits to a display field
MUST NOT retarget the pinned origin); rotation is fail-closed → re-pair wizard;
same-cert reconnects use the stored pin with no prompt — TOFU auto-pin ONLY after this
first explicit trust, never automatically.

3.4 Enrollment (exact wire in §8.1–§8.2): over the now-pinned TLS ONLY, the watch POSTs
`{ deviceAlias, enrollmentSecret }` (`enrollmentSecret`: ≥128-bit CSPRNG, base64url,
single-use). The server creates a PENDING request (opaque unguessable `requestId` +
`expiresAtMs`, max 2 min TTL; disturbance-bounded: max pending
entries, per-IP rate limit, e.g. ≤5 attempts then backoff/lockout, audit log of
`{nonce-prefix, result, ip}` — never secrets) and shows it in the TRUSTED AUTHENTICATED
Mac settings UI (never on the unauthenticated LAN surface). `requestId` is unguessable
(≥128-bit CSPRNG, base64url); there is no authenticated-query lookup by alias.

3.5 Mac owner approves the specific device identity in that trusted UI. ONLY AFTER approval,
and ONLY as the bearer of the pending request over the pinned TLS (the watch re-presents
`enrollmentSecret`), the server delivers the per-device token (`token.<deviceId>`,
`0600`). Token TTL on the pending request: expiry max 2 minutes; unapproved requests
expire silently.

3.6 Fail-closed rules (both ends): cert mismatch → hard `trustError`, nothing persisted,
no retry with token to a new origin; Mac approval denied/absent → no token emitted, pending
entry discarded at expiry; `https` without a stored pin → refuse (no system-PKI fallback);
non-loopback `http:` requires explicit opt-in on BOTH ends; redirects refused; tokens
header-only (`X-Bridge-Token`), `?token=` rejected 401; before trust confirmation the watch
sends NO token, NO audio, NO enrollment secret.

## 4. Session binding (automatic, no manual session IDs)

4.1 The watch UI remains the session authority: `SessionsScreen` tap pins the current thread
(`select-session`) or Auto-follow clears the pin. Every watch command carries that device's
current session id (as today: `SessionCenter.setPermissionCommand(preset, sessionId)`).

4.2 The H server maps `deviceId → currentSessionId` from the authenticated channel the
plugin already polls (new authenticated `GET /watch/binding { watchedSessionId, deviceId }`
or equivalent on the `/watch-bridge/*` prefix). Cappi tools resolve the caller
`exec.agent.id` (brand `SessionId`) against the BINDING FOR THAT DEVICE directly on the real
host — no `watchSessionId` manual config, no cookie forging. Static `watchSessionId`
remains as an optional override (fail-closed when both absent; logged when it disagrees
with the bridge-reported binding).

4.3 Per-device tokens: `token.<deviceId>` entries, `0600`; watch and plugin each hold only
their device's token; the current one-active-watch policy requires revoke before replacement. Persistence survives
profile reload (no isolation erasure); a fresh repo ships NO personal config (no checked-in
tokens/pins/session ids).

4.4 Auto-follow safe behavior: with no sessions, the server reports `none-watched → 409`
with an actionable message; the watch offers `+ New thread` (server creates via the real
in-process `sessionController.create`, never by forging identity). Question/work-talk
state-owned invariants stay enforced atomically (`claimed == watched[device]`, else 409
with no effect).

## 5. Audio schema + watchdog rules (normative shapes in schema)

5.1 Every audio stream reserves `streamId` (opaque id, correlated across
open → partial* → final → closed). Stream states: `warming | ready | capturing | closed |
error`. Mandatory counters: `txChunks`, `txBytes`, `ackFinals`; terminal `receipt`
(`utteranceId` exactly-once final). The ACK-final route has a bounded timeout; errors are
never silent-void: every failure carries `{ code, message, retryable }`.

5.2 Watchdog scope is capture/delivery ONLY: it may demote a stuck uplink/THINKING indicator
(e.g. bound the mic POST like the SSE 40s watchdog; time out THINKING on the recorded
`thinkingSince`), but it MUST NOT cancel a legitimate long agent turn and MUST NOT force
`session.running = false` when the harness is actually running. Distinguish
`mic-delivery-failed` (transport/capture truth, from POST outcome + `mic closed.message` /
helper exit) from true agent state (server `session.running` events). Latch `micOpen` to
transport outcome, never optimistically.

5.3 TTS output default (clean-install rule): built-in Mac system TTS
(system synthesis) is the keyless fallback — no download required. Kokoro
remains the LiveVoice plugin's original default voice, but ONLY as an explicit consented
download (installer shows repo/revision/size/terms + hash-verifies post-download; staged
atomic swap; cache under the configurable runtime root). No mandatory runtime MLX large
model when the system-voice fallback is available; user selects Kokoro explicitly.

5.4 OS gates are surfaced, not scripted around: watch-ASR needs Mac Speech; Mac
input additionally needs Microphone. Speech-locale/platform support is reported in the settings
wizard (deep link + what-to-tap). No bespoke privilege-escalation commands; never bypass
TCC. Prebuilt runtime installation needs no CLT; source build/codesign needs macOS SDK/CLT and follows the explicit build pattern
(dry-run-first, `--apply` required).

## 6. Normal installation order

Install the generic DEBUG/DEV fresh-install APK (not a production-signed release)
→ install LiveVoice tgz then Cappi tgz using official
`dsh plugin --profile web add <path>` → normal first-user OS consent
→ authenticated Mac Settings and watch fingerprint comparison/approval
→ pick a thread → enable watch voice and test. Real DSH model/provider setup is a
prerequisite; the keyless test adapter is never shipped. No manual bridge service,
certificate/token editing or typed session IDs are needed. Prebuilt native runtime
helpers install without CLT; clean-source builds need macOS SDK/CLT.

See the repository `README.md` for the ordinary first-time setup path. Build
and verification commands belong in the tool and contributor documentation; they
do not replace normal first-user consent or device compatibility checks.

## 7. Supported control capabilities

Managed health/state/capabilities and SSE advertise a `features` map. rc.1 has no
queue reorder API: `queueReorder:false` disables that control and requests fail
honestly. Other optional operations follow actual advertised availability, never
blanket legacy parity or fake success. The watch's start/stop/mute/cancel lifecycle
is watch-owned; enabling voice must not activate the Mac microphone.
Discovery probes the bounded UDP range 8788–8797; discovery remains untrusted
candidate liveness, not TLS authentication or permission to send credentials.

## 8. FROZEN pairing wire (exact endpoints/DTO/statuses — implement in parallel)

Conventions (all): JSON only; `Content-Type: application/json`. No URL secrets
(`?token=`/`?secret=` rejected 401). `requestId`/`enrollmentSecret`/`token` are
SENSITIVE: never log, never audit-log beyond prefix (≤8 chars), redacted in fixtures
(all sample values below synthetic). `requestId`: opaque unguessable ≥128-bit CSPRNG
base64url (`^[A-Za-z0-9_-]{22,128}$`); no auth-query lookup (no `GET /pair/*?requestId=`).
Pending TTL max 120s (`expiresAtMs - enrolledAtMs ≤ 120000`). One-use token: single
`poll` approval delivery per `requestId`; persists across restart (0600 store); revocable under the one-active-watch-per-profile policy. Error shape: schema `errorEnvelope`
(`{ ok:false, error, retryable? }`); unknown codes surface verbatim.

8.1 Device LAN surface (per-device auth per §1.6(b); DSH cookie NEVER accepted):

- `GET /pair/info` → `200 { pairProtocol:"turnkey/1", certSha256Pin, serverDisplayName,
  nonce, fingerprint:{ full, short } }` (schema `pairInfo`). CERT ONLY, unauth, pinning
  DISABLED for this one call. Bind rule per §3.2: handshake-derived pin MUST equal
  response `certSha256Pin` or fail `trust-mismatch`.
- `POST /pair/enroll` (pinned TLS ONLY; fingerprint-confirmed per §3.3 or 403
  `approval-required`): req `enrollmentRequest { deviceAlias, enrollmentSecret }` →
  `201 { requestId, expiresAtMs }` (schema `enrollResponse`); `400` bad alias/secret;
  `403` unconfirmed-cert; `409` active-watch/reservation capacity; `429` rate-limited. Creates PENDING; emits nothing secret.
- `POST /pair/poll`: req `pollRequest { requestId, enrollmentSecret }` (both required;
  constant-time secret compare) →
  `202 { status:"pending", requestId, expiresAtMs }` (schema `pollPending`) |
  `200 { status:"approved", deviceId, token, baseUrl?, certSha256Pin }` (schema
  `pollApproved`; `token`: BYTES field, sensitive/never-log; `baseUrl`: immutable
  captured origin echo; `certSha256Pin`: re-asserted pin) |
  `410 { ok:false, error:"approval-expired" }` on TTL expiry (pending discarded) |
  `401 { ok:false, error:"approval-replay|approval-denied" }` on wrong secret / denied /
  replayed one-use. After one `200` delivery the `requestId` is consumed (replay → 401).

8.2 `POST /pair/deny`: DSH-ADMIN ONLY (no secret in body). Req `denyRequest
{ requestId }` over the §1.6(a) `requestRejection` gate → `200 { requestId,
status:"denied" }`; `404` unknown/expired. Never accepts `enrollmentSecret`/`token`.

8.3 Device-approve gate (exact): approve/deny UI is accessible ONLY in the DSH-authed
trusted Settings UI. Server MUST call `ctx.connection.requestRejection({ headers })` and
honor `401|403`; MUST reject CORS preflight abuse / foreign `Origin` and MUST NOT accept
cookie-forwarded or `Authorization`-mirrored LAN headers as device auth; response bodies
limited to identifier-only pending rows (`pendingApproval`: `requestId`, `deviceAlias`,
`deviceId?`, `enrolledAtMs`, `expiresAtMs`, `attemptsLeft`, `noncePrefix?` — never
secrets). Audit log `{ nonce-prefix, result, ip }` only.

8.4 DSH-admin settings/status + approval (all §1.6(a)-gated; same `requestRejection`
exact method as §8.3):
- `GET /admin/pair/status` (or Settings status view-model) → `200 adminStatus
  { fingerprint:{ full, short }, hostCandidates:[...], port, backendStatus,
    pending:[ pendingApproval... ] }` — fingerprint = server cert pin display; host
  candidates = LAN liveness only; port = HTTPS ephemeral/auto port; backendStatus =
  `warming|ready|error` + actionable message (TCC-gated, never bypass).
- `POST /admin/pair/approval`: req `pairApproval { requestId, approve:boolean,
  fingerprintConfirmed:true }` (`fingerprintConfirmed` REQUIRED true or `400`; proves
  Mac-side compare happened) → `200 { requestId, status:"approved"|"denied" }`.
  Approval arms the one-use `poll` delivery; denial makes next `poll` → 401
  `approval-denied`. No `enrollmentSecret` accepted here.

## 9. FROZEN audio service + mic wire (exact TypeScript/host-adapter/SSE)

9.1 Ownership/interface (structural; H/V/W implement in parallel):
- Key: `ctx.liveVoiceWatch`. Exported type from voice package path `'./watch-api'`
  (type-only import allowed; runtime export bundling is P/H concern — H/V MAY avoid a
  runtime import and rely on structural typing).
- H plugin `export const inject` MUST be exactly
  `['tools','sessionController','workspaceController','webServer','connection',
  'liveVoiceWatch','permissionPresets']`. V owns `provide('liveVoiceWatch', service)` with a `ctx.effect`
  read-before-implementation disposer (V reads `ctx.effect` to register disposal; H only
  consumes). No duplicate out-of-process bridge: H supported methods live in the
  actual host adapter; compatibility `watch/*` routes stay in-process with honest
  capability limits (single runtime per profile
  per §2).

```ts
// Structural freeze — from './watch-api' (voice package). PCM explicit.
export type PcmFormat = { encoding: 'pcm16le'; sampleRate: number; channels: 1 };
export type LiveVoiceWatchStatus = 'warming'|'ready'|'capturing'|'closed'|'error';
export type LiveVoiceInputEvent =
  | { kind:'partial'; streamId:string; utteranceId:string; text:string }  // private recognized text; documentation samples are synthetic
  | { kind:'final'; streamId:string; utteranceId:string; text:string }    // private recognized text; documentation samples are synthetic
  | { kind:'error'; streamId:string; utteranceId?:string; code:string; message:string; retryable:boolean };
export interface LiveVoiceWatchService {
  status(): Promise<{ status:LiveVoiceWatchStatus; pcm:PcmFormat; consent:string; message?:string }>;
  setup(opts:{ consent:boolean; mode?:"watch-asr"|"mac-input" }): Promise<{ status:LiveVoiceWatchStatus; pcm:PcmFormat }>;
  createInput(args:{ streamId:string; purpose?:"prompt"|"dictation"; onEvent:(e:LiveVoiceInputEvent)=>void|Promise<void>; signal?:AbortSignal }):
    Promise<{ writePCM(bytes:Uint8Array|ArrayBuffer): Promise<void>|void; end():Promise<void>; dispose():Promise<void> }>;
  synthesize(args:{ text:string; speechId:string; onChunk:(pcm:Uint8Array)=>void; onDone:(receipt:{ speechId:string })=>void; signal?:AbortSignal }):
    Promise<void>;
}
```

- `status/setup` (consent): `setup({consent})` records explicit user consent; capture never
  auto-starts. `ready`-wait precedes any permission/mic start; failure returns actionable
  TCC guidance (deep-link + what-to-tap), never a bypass.
- `createInput({streamId,onEvent,signal})`: resolves input handle with
  `writePCM(bytes)` / `end()` / `dispose()`; `partial`/`final` events carry private recognized
  text + `streamId`/`utteranceId` only (never raw telemetry/counters). One capture is
  mutually excluded with any existing LiveVoice session (second acquirer gets actionable
  `busy`, no steal).
- `synthesize({text,speechId,onChunk,onDone,signal})`: returns `Promise<void>`; streams PCM
  chunks via `onChunk`, terminal `onDone`. PCM format explicit: `PCM16LE`, `channels:1`,
  `sampleRate` = per-start value from the plugin runtime payload read by the TTS player
  (H/V read the actual start payload to define the correct rate; `16000` is ONLY the
  fallback when the payload omits it — do not hard-code).
- Fixtures: all `streamId`/`utteranceId`/text values in schema/docs are synthetic samples.

9.2 Mic wire (compat-preserving):
- `POST /watch/mic/start` req `micStartRequest { streamId, answerRequestId? }`
  (`streamId` non-secret correlator, NOT auth) → `200 micStartOk { streamId, state:"ready",
  receipt? }` when V `status()==ready`, else `503 { ok:false, error:"mic-not-ready",
  retryable:true, message }` actionable (TCC/consent/backend). Preflight only; no audio.
- `POST /watch/mic?streamId=<NONSECRET>` (existing protocol capture preserved):
  chunked PCM body per `PcmFormat`; bounded response with terminal `audioReceipt`
  (`streamId, state, txChunks, txBytes, ackFinals, utteranceId?, code/message/retryable on
  error`). Query `streamId` is a correlator, never a secret (auth is header token/pin).
- SSE `t:'mic'` fields: `{ t:"mic", streamId, state:warming|ready|capturing|closed|error,
  utteranceId?, receipt? }` — readiness + terminal receipt; compat `dictation` error shape
  preserved (`code/message/retryable`, never silent-void).

9.3 W rules: W derives local `micStatus` from service-callback generation even if the
server closes async (no optimistic latch); MUST NOT reset on false `agent.running`
(only true `session.running` events end an agent turn; `mic-delivery-failed` ≠ agent
state). Default normal-mic auto-submit (user record intent) retained; question-dictation
is draft-only (owner-only finals).

9.4 Sensitivity/redaction (applies §§8–9 + schema): fixtures carry shape only with
synthetic samples; `token`/`enrollmentSecret`/`certSha256Pin`/`requestId` never logged;
PUBLIC tree MUST NOT reveal real addresses/paths/role labels: no installed entry
absolute paths, no Mac usernames, no personal config (tokens/pins/session ids).
