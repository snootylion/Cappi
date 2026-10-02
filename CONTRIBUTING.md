# Contributing

## Ownership map (disjoint paths — stay in yours)

| Area | Owner | Paths |
|------|-------|-------|
| Device/app | A | `watch-app/` except B/C paths |
| Characters/avatar | B | `watch-app/**/cappi/**`, `AvatarScreen.kt`, `characters/`, pack schema |
| Transport/bridge | C | `bridge/`, `watch-app/**/net/**`, `service/**`, `core/ViewModel.kt`, transport protocol |
| Voice/plugins | D | `plugins/**`, installers, voice docs |
| Release/docs/toolchain | P | root docs, `.gitignore`, `.github/**`, `tools/**`, `VERSION`, decision files |
| Integration | parent | merges, version bumps coordination |

Three docs are owned outside P and must not be edited by P:
`docs/devices.md`, `docs/characters.md`, `docs/connection-security.md`,
`docs/plugins.md`. Cross-area needs go through the parent orchestrator.

## Hard rules

- No real profiles, services, network endpoints, credentials, or logs in
  the tree. Tests use loopback fixtures and synthetic placeholders only
  (`TEST-FIXTURE` / `EXAMPLE` markers, RFC 5737 addresses).
- No changes to any live DSH installation from this tree. Installers
  dry-run by default; deploys need explicit `--apply` plus review.
- Never invent third-party or upstream licenses: record NOASSERTION with
  provenance, and keep the decision gate (`LICENSE-DECISION.md`) honest.
- No personal IPs, hostnames, or `/Users/...` paths in source (the
  placeholder `/Users/example/...` is the only accepted fixture form).
- Do not claim production, hardware, or legal validation without evidence.

## Verify before you push anything

```bash
./tools/verify.sh   # scan + assets + binaries + gate status + sbom + export dry-run + tools tests
```

Heavier suites (Gradle, bridge Node tests, plugin pnpm checks) run in CI
(`.github/workflows/ci.yml`). Do not run installers, Gradle, or global
pnpm suites by hand outside CI without owner sign-off.

## Packaging

- `./tools/release-bundle.sh` — refuses while publication gates are open.
- `./tools/release-bundle.sh --local` — local candidate (embeds
  `GATE-STATUS.txt`, `-local` in the name, never for publication).
- Exports are allowlist-based (`tools/ALLOWLIST.txt`), reproducible
  (`SOURCE_DATE_EPOCH`, sorted, uid/gid 0), and checksummed into
  gitignored `dist/`.
