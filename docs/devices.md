# Device profiles

Package id `dev.dsh.watch` and the `dsh_remote` preferences file are
retained; only new keys were added (`device_profile_override`,
`home_alias_enabled`, `device_id`). The single process-scoped `BridgeViewModel` in `App`
is untouched — profiles change routing and rendering only, never the
bridge/audio pipeline (one SSE connection, one `TtsPlayer` per process).

## Profiles

| Profile (`device/DeviceProfile.kt`) | When selected | Back at root | Vendor intents |
|--------------------------------------|---------------|--------------|----------------|
| Galaxy Watch4 (`galaxy-watch4`) | Explicit override, or Samsung hardware with model `SM-R86*`/`SM-R87*`/`*Watch4*` | Toggles mic (validated) | Allowed: shortcut classification, Samsung SysUI home |
| Generic Wear OS (`generic-wearos`) | Everything else (unknown models, emulators, blank hardware strings) | System behavior (never stolen for mic) | Forbidden: no Samsung package is ever named |

Resolution (`resolveProfile`): an explicit Settings override always wins; an
unknown override id is ignored (falls back to hardware detection) so a stale
preference can never enable vendor paths. Detection is deliberately cautious:
only known Samsung Watch4 pairs match, all else is generic.

## Stable button ids vs worn labels

`PhysicalButtonId` (`LOWER_HOME`, `UPPER_BACK`) names the physical switch and
never changes with wrist/orientation. Human labels live in
`DeviceProfile.orientationLabels()` (display only) and `buttonRole()` (stable
role description shown in Buttons screen). Never infer physical position from
Android key names.

## Vendor isolation (`device/WatchDevice.kt`)

All Samsung routing sits behind `DeviceProfile.allowSamsungIntents`:

- `classify(action, categories, component, flags)` → `ShortcutToggle` (vendor
  double-press: toggle companion mode, never queue), `HomePress` (ordinary
  HOME through the single/double gate), or `Other`. The raw Samsung signature
  match is reused read-only from `cappi.isSamsungCappiShortcut` (B-owned).
- `samsungHomeIntentOrNull()` returns null on generic; callers fall back to
  the generic system-settings intent plus an explanatory toast.
- The "Samsung Home" menu entry is hidden on generic (`mainMenuEntries(state,
  profile)`); the legacy `mainMenuEntries(state)` keeps the full list.

## HOME replacement: optional and reversible

The manifest keeps both the normal app-grid entry and the
`RemoteHomeActivity` HOME alias. Settings → Watch → "Home replacement"
toggles the alias at runtime (`PackageManager.setComponentEnabledSetting`,
`DONT_KILL_APP`); the grid entry always remains installed, so disabling is
fully reversible. Default is enabled (historical behavior).

## Lower-HOME gate (`util/PressCoordinator.kt`)

Pure-logic owner of the single/double-press protocol (600 ms window via
`LowerPressGate`, first-press session/queue capture via `LowerPressTarget`,
700 ms post-send suppression): single sends the oldest queued message,
double toggles companion mode and swallows a trailing third press. The
activity only feeds snapshots and executes returned outcomes.

## Touch alternatives (all profiles)

Mic, stop, menu, steer-oldest, and response controls on the Home screen are
touch-first and profile-independent. On generic, Back is system navigation
everywhere and the Buttons screen documents this.

## Avatar/remote mode switch (touch-first, all profiles)

The companion character UI (`avatarMode`) versus the remote control UI is
flipped by ONE pure UI-mode toggle,
`BridgeViewModel.toggleAvatarMode()` (no mic, queue, SSE, or voice side
effects). Every profile — including generic Wear OS with no Samsung buttons
— switches entirely by touch:

- Menu → **Avatar mode · On/Off** (`avatar-toggle` route; label follows the
  live state, toggles and returns Home so the result is visible).
- Settings → **Display** → **Avatar mode · On/Off** pill.
- Exit by touch from inside avatar mode: **touch-hold the avatar face** to
  reopen Menu (avatar home is the nav root, so swipe-back cannot leave it),
  then **Avatar mode · On** toggles back to remote.

The hardware paths are preserved as convenience aliases for the same flip:
double-press of `LOWER_HOME` (press-gate) and the Samsung shortcut intent
(`ShortcutToggle`). No feature requires them; generic devices never need a
hardware key to reach either mode. The Buttons screen documents both the
shortcut and the touch path.

## Endpoint onboarding (render-only)

`DeviceSettings.isPlaceholderEndpoint` detects a blank base or the checked-in
documentation placeholder (`192.0.2.1`, RFC 5737). While disconnected on it,
Home shows "No bridge yet — pair with your Mac" (tap opens Menu → Pair with
Mac) instead of a misleading retry; a missing `https://` pin surfaces as a
trust error with Settings guidance instead of an endless silent retry (both
still bounded by the five-minute connection deadline). Settings validates before saving, so
stored prefs keep the last valid values.

## Turnkey pairing wizard (default; raw fields under Advanced only)

First run opens the pairing wizard, not raw connection fields
(`ui/PairingWizardScreen.kt`, state rules in `core/PairingCenter.kt`,
transport in `net/PairingTransport.kt`):

- Scan lists untrusted LAN candidates (UDP bounds kept: 512 B, nonce regex,
  all ten default UDP ports 8788..8797 upfront on one socket, ≤8 total
  received packets, ≤3 s monotonic deadline) — liveness only, no secret before trust.
- Tapping a candidate fetches `GET /pair/info` over provisional TLS (pinning
  disabled for this one cert-only call; no token/secret on the request). The
  pin and both fingerprint displays (full colon-hex + 96-bit 6×4 short) are
  derived from the ACTUAL handshake certificate and must byte-equal the body
  assertion, or the candidate fails `trust-mismatch` with nothing persisted.
- The user compares the watch fingerprint against the Mac DSH Settings
  display and taps Confirm ON THE WATCH — only then is a CSPRNG enrollment
  secret generated and `POST /pair/enroll` sent over the now-pinned TLS.
- The wizard polls `POST /pair/poll` on a finite TTL-bounded backoff until
  the Mac owner approves; base + token + pin persist atomically ONLY on an
  approved response whose pin matches the confirmed record AND the per-round
  live handshake pin (never the approved pin itself — vacuous self-compare
  refused), and only while the server TTL has not expired (late approvals
  are discarded, nothing persisted). Rotation is fail-closed → re-pair wizard, never silent TOFU.
- Raw base/token/pin/insecure-LAN fields stay available ONLY under
  Settings → Advanced (existing paired installs migrate untouched).
- One paired device per APK: a stable `device_id` (random UUID, first-run
  generated) is stored alongside the token in the private `dsh_remote` prefs;
  secrets are never logged or dumped.

## Watch-mic transport status (preflight + bounded uplink)

- Boot/pairing never asks for microphone permission. Only an explicit record or
  dictation tap requests `RECORD_AUDIO`; the granted callback resumes the
  captured action only while the same pairing is current. Question dictation
  cancels local TTS before capture; it remains draft-only, never auto-submit.
- Every record tap runs `POST /watch/mic/start` (pinned, `streamId`
  correlator) BEFORE `AudioRecord` starts; capture begins only on `ready`.
  A `503 mic-not-ready` surfaces actionable backend guidance; a `404` means
  a legacy bridge and falls back explicitly to the direct uplink (no
  insecure downgrade — pin/redirect rules still enforced).
- The uplink (`POST /watch/mic?streamId=…`) is bounded: 40 s write-activity
  watchdog + 30 min absolute cap (matching the bounded wakelock); read
  errors/zero-reads are counted (`readErrors`/`zeroChunks`) and surfaced,
  never silently swallowed.
- Normal record-off and question **End** stop the input read loop but keep the
  owned service/socket/generation alive: close the output with EOF, read the
  bounded receipt, then clean up. Finish uses a generation/stream-fenced callback
  on the existing service, never a new foreground-service start. Force abort,
  disposal, revoked/rebound pairing, or OS destruction instead disconnect and
  suppress stale outcomes; rebind closes old input before changing credentials.
- EOF/HTTP200 alone is NOT delivery. Managed upload receipts are ≤16 KiB raw,
  fatal-UTF8/strict-JSON decoded and correlated to the current stream. Normal
  success requires `delivered:true` and `ackFinals>=1`; question draft success
  requires `drafted:true,delivered:false,ackFinals:0`, never SDK admission or an
  automatic answer. Non2xx/no-speech/admission failure shows safe guidance.
  Same-stream error is terminal; delayed ready/capturing/closed cannot erase it.
  Only an explicit new stream starts fresh. Legacy receipts are accepted only
  after explicit preflight404 fallback.
- `service/MicStatus` publishes `{ generation, streamId, state, txChunks,
  txBytes, zeroChunks, readErrors, rmsBucket }` (levels/counters only — never
  audio, transcripts, URLs, or secrets); `micOpen` latches on transport
  ACCEPTED, never on start-intent. Server `t:'mic'` events route only the
  current `streamId` and never force `session.running = false`, so long agent
  turns are never cancelled by the delivery watchdog.

## Ambient display (`util/AmbientDisplay.kt`)

Pure `windowAlpha` / `burnInOffsetDp` policy: full alpha while interactive or
showing the ambient companion face, hidden on low-bit ambient, 15% dim
otherwise; ±2dp burn-in drift only when the hardware requires protection.

## Device adapter APIs (`util/`)

- `Haptics`: `buzzMedium` (send), `buzzDouble` (mode toggle/approval),
  `buzzLight` (mic/reconnect), `buzzError`. No-op without a vibrator.
- `StateWakeController`: bounded `SCREEN_BRIGHT_WAKE_LOCK` pulses (8 s max)
  for questions/speech/work changes while the companion root is foreground;
  single-process owner guard; releases on pause/stop/leave. Never opens over
  another app.

## Lint

`lint { abortOnError true; baseline = file('lint-baseline.xml') }` — errors
break the build; warnings are either fixed or recorded. Release builds ARE
lint-gated (AGP default `checkReleaseBuilds=true`, no opt-out): lint runs
explicitly as `lintDebug` + `lintRelease` in the release gate and also as
part of `assembleRelease` (`lintVitalRelease`).

Real fixes applied: `AutoboxingStateCreation` in `MainActivity` (primitive
state holders), `UseKtx` in `DeviceSettings` and `core/ViewModel`
(`edit{}`), `ModifierParameter` in `Theme.DshDot` (all callers use named
args), `WakelockTimeout` in `service/VoiceService` (bounded 30 min
`acquire(timeout)` so the OS always reclaims a leaked lock; captures release
on stop long before it), and `WearRecents` in new `WatchDevice` code
suppressed in-code with a `NEW_TASK`-required justification.

Accepted baseline entries (`watch-app/app/lint-baseline.xml`, warnings only):

- `GradleDependency` (pinned versions available newer): versions stay pinned
  for reproducible offline builds; bumps are a deliberate parent decision.
- `UnusedResources` (`dot_*`, `ember_*`, `ic_*`): character-asset ownership is
  B's; `AvatarScreen` resolves some by name (`getIdentifier`), so deletion
  would break the pack facade. Parent/B decide.
- `DiscouragedApi` (`getIdentifier` in `AvatarScreen`, B-owned): required for
  pack-driven asset lookup.
- `WearRecents` (`taskAffinity` manifest; `NEW_TASK` in `MainActivity`
  wifi/settings launches): preserved launch behavior; changing task affinity
  alters recents/system routing — parent decision.
- `DataExtractionRules` (manifest `allowBackup`): `allowBackup="false"` is the
  intended behavior; the Android 12+ attribute is a future migration.
- `ImplicitSamInstance` (`context.stopService(Intent(...))` in
  `service/VoiceService.stop`): audited false positive — the argument is an
  explicit `Intent`, not a SAM conversion; stopping by explicit intent is the
  intended behavior (starting a service merely to stop it would create a
  spurious foreground obligation). Preserved, not hidden.
- `CustomX509TrustManager` in `net/SecureTransport` (audited, 2026-09-27):
  the manager accepts EXACTLY the pinned certificate — `checkServerTrusted`
  compares the presented chain's SHA-256 (base64, constant-time
  `MessageDigest.isEqual`, 32-byte validated, optional `sha256/` prefix)
  against the user-entered pin and throws on mismatch/empty chain; client
  auth delegates to the platform default; `getAcceptedIssuers` delegates to
  the platform default; the manager is installed ONLY for pinned `https://`
  bridge URLs (unpinned `https://` is refused fail-closed, `http://` needs the
  explicit insecure-LAN opt-in, hostnames are accepted only in pinned mode
  because the pin — not a LAN IP — is the stable identity). No silent trust,
  no system-PKI fallback. JVM tests (`SecureTransportTest`) cover
  normalization, fail-closed refusal, header-only auth, and redirect refusal
  against a mock host.

## Signing

Debug: standard auto-generated debug key, no checked-in keystore, no
passwords in the tree. Release: only via external `release-signing.properties`
(see `release-signing.properties.example`) or `RELEASE_*` environment
variables; unsigned otherwise.

## Managed host capabilities

Snapshots/state carry `features.queueReorder` and `features.openMac` booleans.
Explicit false guards unsupported commands with guidance and hides the Open Mac
image control; the local image viewer remains available. Legacy peers omitting
these fields retain existing behavior. Queue rows still support Send/Remove;
there is no reorder gesture in this release and no optimistic local reorder.
`features.micCancel` is different: omission means **false**, including hello.
Only advertised support permits authenticated `mic-cancel` for the captured owned
stream during force abort or warming cancellation. Normal finish uses EOF/drain.
This command does not cancel an SDK agent, follow mode, voice link or voiceActive.

Runtime test TLS fixtures are generated by `generateSdwTestTls` under ignored
`app/build/generated/sdwTestAssets`, included only in the instrumentation APK.
No private key fixture is committed or packaged in the main/release APK.

## Isolated runtime validation (2026-10-01)

A genuine Wear OS 5 / API 34 ARM64, 384×384 private round emulator passed all
13 instrumentation tests: fresh wizard and real UDP discovery, actual peer
fingerprint Confirm/enroll/approval/pinned atomic preferences, normal Home/SSE,
authenticated Ping, explicit microphone permission grant followed by backend503
(no capture/PCM and visible Error), trusted rediscovery after HTTPS port restart,
native bounded-image decoding, and 11 existing avatar rendering checks. No manual
secret entry or production device/service was used. The server was an isolated
H-shaped fixture; actual native DSH SDK integration is a separate verification.

Images are capped at 6 MiB before decoding. Native header-only inspection rejects
nonpositive dimensions, edges over 8192 or area over 16 million pixels before
bitmap allocation. Full images sample to at most 480 pixels per edge (under1 MiB
ARGB bitmap); malformed/oversized images show a friendly unavailable message.

Physical Watch4 buttons, real microphone/acoustic echo and real-device ASR remain
unverified here. Emulator503 proves no input starts. A DEBUG-only in-process
synthetic input seam exercises the real VoiceService TLS/chunked HTTP loop,
record-off EOF/receipt, errors/no-speech, draft-only End, force/warming cancel,
error ordering and rebind. It has no receiver/main asset and no injectable path
in the release factory. Synthetic fixture ACKs prove APK transport, NOT acoustic
capture or native SDK admission; those require independent host/device evidence.
