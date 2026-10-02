# Transport endpoints (contributors C/J)

Binding contract for the watch ⇄ bridge transport. The actual watch SSE route
is **`GET /watch/stream`** (an older foundation note naming `/watch/events`
was wrong; that path never existed on the bridge).

Protocol version **`0.2.0`** (minimum compatible `0.1.0`; see
`bridge/protocol.mjs`). The SSE `hello`, `GET /watch/state` and
`GET /watch/capabilities` advertise `{ version, features }`; peers that
cannot parse the version must surface a compatibility error instead of
proceeding.

## Bridge surface

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| GET | `/watch/health` | none | liveness; also the pin-validation probe (no token sent) |
| GET | `/watch/stream` | `X-Bridge-Token` header | SSE; `hello` (protocol + character) + full `snapshot` on open |
| GET | `/watch/state` | `X-Bridge-Token` header | full snapshot (incl. `character` + `protocol`) |
| GET | `/watch/capabilities` | `X-Bridge-Token` header | active pack `{ characterId, characters, modelSelectable, roles }` + protocol |
| GET | `/watch/image?ref=` | `X-Bridge-Token` header | image bytes; `ref` is routing metadata, not a secret |
| POST | `/watch/mic[?answerRequestId=]` | `X-Bridge-Token` header | chunked PCM uplink |
| POST | `/watch/command` | `X-Bridge-Token` header | `{cmd, ...}` body, JSON, 1 MiB cap (incl. `character-select`) |
| POST | `/watch/cappi` | `X-Bridge-Token` header | session-bound, capability-resolved; `clear` resets |
| GET | `/watch/pair-probe?nonce=` | none | liveness/consistency only — NOT relay-proof, never authentication (retained for the watch insecure-LAN legacy path) |
| UDP | discovery port (8788) | none | untrusted candidate list; trust comes from the certificate pin |

## Character contract (protocol 0.2.0)

- Canonical registry: `characters/registry.json` (B-owned, read-only for
  bridge/plugin). Callable actions are the ACTIVE pack's `model_selectable`
  list; selection resolves null/blank/unknown to the registry default.
- `POST /watch/command {cmd:'character-select', characterId}` selects the
  pack → `{ ok:true, characterId }` (unknown ids: HTTP 400 + compatibility
  error). The selection persists in the private state dir and is announced
  as SSE `t:'character' {characterId}`; a pack switch retires any held model
  action. The watch re-sends its local choice on each hello/reconnect.
- `POST /watch/cappi {action, sessionId}`: `sessionId` MUST be the calling
  harness session id (the plugin forwards `exec.agent.id` verbatim). The
  bridge checks it against the watched session ATOMICALLY before any effect
  (no await between check and effect — TOCTOU guard): missing → 400, no
  watched session → 409, mismatch → 409 with no state change.
- Legacy `/watch/cappi` ids (the frozen 18-id vocabulary) map to the active
  pack's roles (`idle*`/`breath*`/`relaxed`→`idle`, `talk*`→`talk`,
  `work`→`work`, `dance`→`celebrate`; `shadow` has no equivalent and is
  rejected with the callable list). State-owned cues (`question`,
  `static_hold`) are never model-requestable on any pack.
- SSE to the watch: `t:'cappi' {action}` (held model action, `null` = auto),
  `t:'character' {characterId}` (pack switch). Model speech/question state
  is never carried here.

## Rules

- Token travels in the `X-Bridge-Token` header, never in the URL. `?token=`
  is rejected with HTTP 401 (`token in URL is rejected`); token-bearing
  `open-mac` targets are rejected with HTTP 400. No state-changing request
  is ever issued as a URL/probe GET: capabilities/discovery/health/pair-probe
  are read-only or liveness-only.
- HTTPS with pinned certificate SHA-256 (base64 of the DER bytes, `sha256/`
  prefix accepted — same convention on the watch `SecureTransport`, the
  bridge `tls.mjs`, and the plugin `pinned-fetch.ts`), verified before any
  token/audio/data. Cleartext only with explicit mutual opt-in (see
  `docs/connection-security.md`); no silent downgrade.
- The bridge never redirects; clients refuse 3xx rather than following.
- Discovery bounds (512 B cap, `[\w-]{1,64}` nonce, ports 1–65535, ≤8
  replies, deadline, cancellable) are transport hygiene, not authentication:
  only the pin confers trust.
- Blank base means unpaired: nothing is dialled or polled. The RFC 5737
  `http://192.0.2.1:8787` value appears only as a recognised-unpaired
  migration marker, never as a connection target.
- Voice/question semantics, session/queue controls and stale-request
  protection are unchanged (see `fixtures/` and the bridge test suite).
- Tests use loopback fixtures only; no live credentials in tests.

## Fixtures

- `fixtures/cappi-command.json` / `fixtures/cappi-response.json` — model-action round-trip (session-bound form).
- `fixtures/character-select.json` — pack-selection command round-trip.
- `fixtures/capabilities.json` — authenticated capability snapshot shape.
- `fixtures/health.json` — unauthenticated liveness shape.
- `fixtures/pairing.json` — pairing material shape (pin + endpoint, no secrets).
