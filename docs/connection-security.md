# Connection security (contributors C/J; turnkey wizard: W)

How the watch and the bridge find, identify and trust each other. The actual
watch SSE route is **`GET /watch/stream`** (not `/watch/events`).

## Trust model

- The bridge serves **HTTPS** with a private, locally generated certificate
  (see `bridge/setup-cert.sh`; the key is `0600` and never committed).
- Turnkey pairing is the default (`0.3.0-rc0` wizard: Menu → Pair with Mac).
  `GET /pair/info` is fetched over provisional TLS (pinning disabled for this
  one cert-only call — no token, no secret on it); the pin and both
  fingerprint displays (full colon-hex + 96-bit 6×4 short) are derived from
  the ACTUAL handshake certificate and must byte-equal the body assertion
  (`trust-mismatch` fails closed, nothing persisted). The user compares the
  fingerprint against the Mac DSH Settings display and confirms explicitly
  BEFORE any secret is generated or sent. `POST /pair/enroll` runs over the
  now-pinned TLS and carries the explicit confirm assertions the host gate
  requires (else `403 approval-required`): `X-Fingerprint-Confirmed: true`
  plus the public `X-Cert-Pin: sha256/…` handshake pin (never a secret);
  the enrollment secret stays in the JSON body only, never the URL.
  `POST /pair/poll` likewise carries secrets in the body only (`?token=` /
  `?secret=` refused client-side and `401` server-side). Pairing JSON bodies
  are parsed by a strict bounded typed reader (duplicate / unknown /
  nested-spoof / trailing-data fail closed; value shapes still allowlisted).
  Cert rotation is fail-closed
  (hard `trustError`, re-pair wizard) — never silent TOFU. Per-device
  enrollment secrets/tokens are high-entropy CSPRNG bearer values sent ONLY
  in JSON bodies over pinned TLS (never URLs/logs); pending approvals
  expire (≤120 s TTL), one-use request ids replay as `401`.
- Legacy manual pairing (Settings → Advanced only): the watch pins the
  certificate's **SHA-256 fingerprint** (base64 of the DER
  bytes, `sha256/…` display form), entered by hand. Existing paired installs
  keep working unchanged; new setups use the wizard above. The pin is
  verified during the TLS handshake **before** any token, audio or data is
  sent. The DSH plugin (`plugins/dsh-watch`, `src/pinned-fetch.ts`) enforces
  the identical convention: `https:` targets require the pin
  (`DSH_WATCH_BRIDGE_PIN`), verified pre-token with no system-PKI fallback
  and no downgrade; redirects are refused, never followed. The plugin secure
  default is loopback `https://127.0.0.1:8787` (the bridge HTTPS default):
  onboarding copies the bridge-printed `sha256/…` pin into
  `DSH_WATCH_BRIDGE_PIN` before any token is sent, and without the pin the
  plugin refuses fail-closed.
- The pin is the **stable bridge identity**: it survives DHCP/IP changes,
  while a bare IP address does not. Discovery finds candidates; only the pin
  confers trust.
- The token travels only in the **`X-Bridge-Token` header**, never in a URL.
  `?token=` is rejected with HTTP 401. The bridge never redirects; clients
  never follow redirects.

## Pairing (first run)

Turnkey (default):

1. On the watch: Menu → Pair with Mac → Scan → tap the Mac candidate →
   compare the fingerprint with DSH Settings on the Mac → Confirm on the
   watch → approve the device on the Mac → paired (base + token + pin
   persist atomically).
2. If the Mac surface is missing (`GET /pair/info` 404 on a legacy
   bridge), the wizard says: Install LiveVoice and Cappi in DSH Settings
   on the Mac first, then scan again.

Legacy manual (Settings → Advanced only):

1. On the Mac: `BRIDGE_STATE_DIR=... bridge/setup-cert.sh`, then start the
   bridge (`BRIDGE_TOKEN=... node bridge.mjs`). It prints
   `Certificate pin : sha256/...`.
2. On the watch (Settings → Advanced): enter the bridge base
   URL (`https://<host>:8787`), the token, and the `sha256/...` pin.
3. The watch verifies the pin on every connection — commands, SSE, state,
   images and the mic uplink all use the same trusted factory
   (`SecureTransport`).

Until paired the watch is **blank/unpaired**: no default host is dialled and
no placeholder address is polled.

## Discovery (untrusted candidate list)

UDP discovery (`DSHW1DISCOVER <nonce>` → `DSHW1BRIDGE <nonce> <port>`) is
**untrusted**: any LAN host can answer, and the legacy `/watch/pair-probe`
nonce-echo is **not identity** (a relay forwards the challenge verbatim),
so it is a liveness check only — never authentication under any name.

Rules enforced on both sides:

- The watch sends probes to **all UDP ports 8788..8797 upfront on the same
  socket**, so an old development bridge owning 8788 does not hide the managed
  bridge. Both bridge implementations select the FIRST available default port
  in that bounded list; they never fall back to an unknown random port.
- Packets over 512 bytes are dropped (including truncated oversized replies);
  nonces must match `[\w-]{1,64}`; service ports must be 1–65535. There are
  at most 8 received packets TOTAL and a ≤3 s monotonic deadline per scan,
  including bounded candidate checks. These are hygiene, not authentication.
- Trusted rediscovery validates the ACTUAL peer X509 against the stored PIN
  before any device token reaches the wire, then requires authenticated
  `GET /watch/health` success. DHCP/HTTPS service-port restarts retain the
  stable device token and PIN, without manual token/port entry. Wrong PINs
  require re-pairing and never replace the trusted record. Settings Test/Ping
  uses the same authenticated overload with an immutable token/generation;
  unauthenticated health is explicitly legacy-only, not a managed auth bypass.
- An explicit `BRIDGE_DISCOVERY_PORT` is honored exactly (1..65535), with no
  fallback on collision. Custom ports outside 8788..8797 are not automatically
  probed: use the service HTTPS address under Advanced. Exhaustion/bind failure
  appears in legacy `health.discovery` state/action guidance; free a known port
  or configure the advanced port rather than silently losing discovery.
- Stale scans are cancelled/ignored after settings or session changes and
  never overwrite manual Settings.
- The `/watch/pair-probe` nonce-echo endpoint is RETAINED (not removed): the
  watch's insecure-LAN legacy path (`pairVerified`) depends on it and that
  code is owned by contributor I, whom J must not edit. It stays a
  liveness check only — never authentication, never a trust decision, never
  described as keyed-authentication. No new client may treat a pair-probe
  pass as identity.

## Insecure LAN legacy mode (explicit opt-in only)

Cleartext `http://` works only when **both** sides opt in:

- Bridge: `BRIDGE_ALLOW_INSECURE_HTTP=1`.
- Watch: the visible "insecure LAN" toggle (persisted as
  `allow_insecure_lan`; default off).

There is no silent downgrade: a pinned `https://` endpoint never falls back
to `http://`, and an unpaired watch never enables it by itself.

## Watch-mic preflight (turnkey, W)

No microphone permission is requested at app boot or during pairing. Only an
explicit record/dictation tap requests `RECORD_AUDIO`; after grant, its captured
action resumes only if pairing did not change while the dialog was open.
Explicit question dictation cancels local TTS playback first to avoid capturing
the spoken question; drafts still never auto-submit.

Every record tap runs `POST /watch/mic/start` (`{ streamId }`, non-secret
correlator; auth is header token + pinned TLS) BEFORE the microphone opens;
capture starts only on `ready`. `503 mic-not-ready` surfaces actionable
backend guidance; `404` means a legacy bridge and falls back explicitly to
the direct uplink with pin/redirect rules still enforced. The uplink
(`POST /watch/mic?streamId=…`) is bounded (40 s write watchdog + 30 min
absolute cap); `t:'mic'` server events route only the current `streamId` and
never end an agent turn. Telemetry is counters/levels only — never audio,
transcripts, URLs, or secrets.

Normal record-off/question End is graceful: stop input, retain the current
service/socket/generation, send EOF, wait at most the bounded response timeout,
and only then clean up. Neither EOF nor HTTP200 means SDK admission: managed
receipts must match streamId and pass ≤16 KiB raw/fatal UTF8/strict JSON checks.
Normal success is `delivered:true,ackFinals>=1`; question-only draft success is
`drafted:true,delivered:false,ackFinals:0` and never auto-submits. Failures/no-speech
use safe static guidance, not raw response/transcript/error text. Same-stream
error cannot be overwritten by delayed ready/capturing/closed; new explicit
streams initialize fresh. Legacy admission-less receipts require explicit404
preflight fallback.

Force abort/rebind/dispose/revoke hard-disconnects instead of EOF and suppresses
late outcomes. Endpoint/credential mutation synchronously aborts old input first;
its cancellation keeps the captured OLD peer/PIN/token. When advertised
`features.micCancel:true` (absent legacy = false), only force/warming cancellation
sends authenticated `POST /watch/command {"cmd":"mic-cancel","streamId":…}`.
The id is the owned nonsecret preflight/input correlator, never recycled. The host
returns actual slot cancellation; unknown/repeated ids are idempotent false and
foreign active slots are refused. This does not change an SDK agent/session,
follow mode, voice link or voiceActive. Normal finish never sends this command.

## Bridge configuration (env)

| Variable | Default | Notes |
|---|---|---|
| `BRIDGE_PORT` | `8787` | Validated 1–65535 |
| `BRIDGE_DISCOVERY_PORT` | first available `8788..8797` | Explicit custom port validated 1–65535, no fallback; outside default list use Advanced service address |
| `BRIDGE_STATE_DIR` | `~/.local/state/dsh-watch-bridge` | External state (dir `0700`, token file `0600`, character selection `0600`); never the source tree. The directory mode is enforced even for pre-existing/migrated state |
| `BRIDGE_TOKEN` | (generated) | Explicit token wins over the state file |
| `BRIDGE_TLS_CERT` / `BRIDGE_TLS_KEY` | `<state>/bridge-cert.pem` / `bridge-key.pem` | Missing + no opt-in = fail closed |
| `BRIDGE_ALLOW_INSECURE_HTTP` | off | `1` = cleartext legacy opt-in |
| `DSH_BASE` | `http://127.0.0.1:3083` | Loopback harness; http/https only |
| `DSH_HOME` | `~/.dsh` | Credential home override (tests use fixtures) |
| `WATCH_ACCEPT_MAC_MIC` | off | Legacy Mac-mic transcripts; watch mic is the default path |

## DSH adapter compatibility

- The harness cookie is **v1** (`dsh-auth-*` HMAC, 30-day mint). Format
  changes must bump `COOKIE_VERSION` in `bridge/dsh-auth.mjs`.
- Supported runtime: **Node.js 26+**. The adapter uses the global `fetch`
  and the global `WebSocket` with `(url, { headers: { Cookie } })`.
  Verified ONLY on Node v26.5.1: the Cookie header IS sent on the WS mux
  Upgrade (raw-capture gate: `bridge/websocket-compat.test.mjs`, which fails
  loudly on runtimes that drop it). Node 22 is NOT advertised because the
  handshake-with-headers behavior was never measured there — support stays
  pinned to the verified major. The unary RPC path (`POST /api/*`) sends the
  cookie the same way and is the primary carrier.
- Tests never read real credentials: `DSH_HOME` fixtures only.

## Character effects (protocol 0.2.0)

- `POST /watch/cappi` requires the calling harness session id as
  `sessionId` (the plugin forwards `exec.agent.id` verbatim). The bridge
  matches it against the watched session atomically before any effect:
  missing → 400, none watched → 409, mismatch → 409 with no state change
  (TOCTOU guard; see `bridge/session-binding.mjs`).
- `POST /watch/command {cmd:'set-permission', preset, sessionId}` requires
  the calling harness session id as `sessionId` (the watch sends its calling
  session id verbatim). The bridge captures the watched id once and matches
  it before the harness RPC: missing → 400, none watched → 409, mismatch →
  409 with no permission change and no RPC issued. A stale caller (pinned-A
  while the bridge follows B) is rejected without effect.
- `POST /watch/command {cmd:'approve', requestId, …, sessionId?}` accepts an
  optional calling session id: when present it is matched against the
  captured watched id before the harness RPC (mismatch → 409, no answer
  sent); when absent the call stays token-auth only for legacy watches.
  Queue commands (`submit`/`steer`/`queue-remove`/`queue-clear`/`queue-move`)
  keep their documented queue semantics (no session binding; prompts resolve
  against the active session at send time).
- `POST /watch/command {cmd:'character-select', characterId}` is the
  watch's own pack choice (token-authenticated; no harness session binding
  applies). Unknown ids fail with a compatibility error; the choice persists
  in the private state dir and is announced as SSE `t:'character'`.
- `GET /watch/capabilities` (authenticated, pinned transport) publishes the
  active pack's callable actions for plugins (`characterId`, `characters`,
  `model_selectable`, `roles`, plus uninterpreted `version`/`features`).
  The plugin consumes exactly those fields and never fabricates state when
  the bridge is unreachable. Capability/discovery/health/pair-probe GETs
  are read-only or liveness-only — no state-changing URL/probe requests exist.

## Mac image open (no token URL)

`POST /watch/command {cmd:"open-mac", imageRef}` opens bridge image bytes on
the Mac from a private temp file. Raw `{url}` opens plain `https:` links
only — `http:` and non-https schemes are rejected with HTTP 400, as are
URLs embedding credentials (`user:pass@host`, which would leak to the opened
host) and token-bearing URLs (`?token=`/`&token=`).

## Legacy HTTP JSON gate

`POST /watch/command` and `/watch/cappi` share one `application/json` gate,
raw 1 MiB body cap, fatal UTF-8 decoding and a dedicated strict JSON grammar
parser. Duplicate keys (including escaped aliases and nested objects), invalid
syntax/trailing input and non-object roots are rejected without echoing bodies.
Valid legacy arrays such as `choiceIds` remain supported; a flat-object mode
exists for bounded settings DTOs. PCM `/watch/mic` is a binary stream, not JSON,
and is deliberately excluded from the JSON Content-Type requirement.

Managed snapshots advertise `features.queueReorder` and `features.openMac`.
Explicit false disables unsupported commands (Open Mac is hidden in the image
viewer); absence defaults true only for legacy compatibility. Queue state is
not optimistically reordered after an unsupported server response.
