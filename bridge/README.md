# bridge/

Watch ⇄ DSH harness bridge (zero npm dependencies). Supported runtime:
**Node.js 26+** (global `fetch` + global `WebSocket`; the Cookie-on-Upgrade
handshake is verified only on Node 26 — see `docs/connection-security.md`).

## Modules

- `bridge.mjs` — entry point: watch HTTP(S)+SSE routes, voice lease, prompt
  queue/steer, mic uplink, character/capability routes. Importing it opens no
  sockets and touches no credentials (all startup I/O is main-guarded; the
  character registry loads lazily on first request).
- `protocol.mjs` — protocol version/features + compatibility errors. No I/O.
- `characters.mjs` — canonical registry binding (`characters/registry.json`,
  read-only): pack selection, per-pack capabilities, legacy cappi alias,
  state-owned refusal. No I/O (persistence is injected).
- `session-binding.mjs` — atomic watched-session guard for character effects.
- `watch-actions.mjs` — character domain router (`/watch/cappi`,
  `character-select`, `GET /watch/capabilities`) with injected deps for
  offline tests. No I/O on import.
- `config.mjs` — pure env parsing (`BRIDGE_PORT`, `BRIDGE_STATE_DIR`,
  `DSH_HOME`, TLS paths, insecure opt-in). No I/O on import.
- `storage.mjs` — external state-dir token load/generate (`0600`, dir
  `0700` enforced even for migrated state).
- `tls.mjs` — pinned HTTPS: credential loading, SHA-256 pin, fail-closed
  server creation (no redirects, ever).
- `auth.mjs` — header-only token check (`X-Bridge-Token`; `?token=` rejected).
- `discovery.mjs` — bounded UDP responder (512 B cap, nonce/port validation).
- `dsh-auth.mjs` — isolated DSH credential access (`DSH_HOME`, v1 cookie).
- `dsh.mjs` — harness adapter (RPC/WS-mux, follow/control/$events streams).
- `models.mjs` — session-scoped model commands (native RPCs only).
- `cappi.mjs` — FROZEN legacy action vocabulary (backward alias source).
- `cappi-registry.mjs` — allowlist resolution from an injected character
  registry (canonical v2 + legacy shapes), frozen fallback.
- `setup-cert.sh` — private local certificate generation (`--dry-run`,
  `--fingerprint`). The key is never committed.
- `service.sh` — macOS keep-alive (`install [--dry-run]`, `status`,
  `uninstall`; ports/state/TLS configurable via env).
- `build-asr.sh` — Swift ASR helper compile (`build [--dry-run]`, `clean`).
- `asr-helper.swift` + `asr-helper-tests.py` — mic PCM helper + its tests.

## Run

```bash
node --test *.test.mjs            # offline; ephemeral ports/temp dirs only
BRIDGE_TOKEN=... node bridge.mjs  # first run (token persists in state dir)
```

Actual watch SSE route: `GET /watch/stream`. Pairing, pinning and the
insecure-LAN opt-in are specified in `docs/connection-security.md` and
`protocol/transport-endpoints.md`.

Never committed here: `token` files, `bin/` binaries, `*.pem` keys/certs,
logs or transcripts. Set `BRIDGE_TOKEN` in the environment on first run.
