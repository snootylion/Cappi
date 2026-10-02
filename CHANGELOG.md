# Changelog

All notable release-tree changes. The bundle label (`VERSION`) is
`0.2.0-rc0`, and all components (`watch-app`, both plugins) are at
`0.2.0-rc0` (see "Final packaging hardening" below).

## [Unreleased] — final packaging hardening

### Changed

- Component versions unified at `0.2.0-rc0` (`watch-app`
  `versionName`, both plugin manifests, bundle label). Earlier notes
  saying plugins "remain at `0.1.0`" are superseded.
- `.gitignore`: local Gradle cache `.gradle-home/` ignored at all
  levels; fixed the `.vscode/extensions.json` exemption typo. Scans
  exclude the ignored cache but reject staged cache entries.
- `tools/ALLOWLIST.txt`: clean source archive now ships
  `.github/workflows/ci.yml` and `plugins/dsh-watch/SKILL.md`;
  plugin `exports`/`files` manifests carry exact-expectation tests.
- `tools/inspect-artifacts.py`: placeholder exemptions are match-local
  only; bounded recursive scan of nested archives (APK/zip/tgz) with
  depth/count/expanded-size limits; symlink escapes and oversize or
  unscannable members rejected; printable-string inspection of DEX /
  resources carriers under explicit policy (opaque third-party binary
  listed + hashed only).
- `tools/release-bundle.sh --local --artifacts`: bundles the unsigned
  RELEASE APK plus installable plugin `.tgz` packs (isolated local
  `npm pack --ignore-scripts --offline` from the already-built
  packages; nothing installed, deployed, or executed). Source exports
  stay source-only.
- Root docs (`WORKPLAN.md`, `LICENSE-DECISION.md`) state current
  verification evidence — 290/290 Android unit, 11/11 instrumented on a
  phone emulator (non-Wear, no Watch4 claim), 121/121 bridge, 75/75
  watch plugin, 137/137 voice plugin — with no hardware, production,
  or live-DSH compatibility claimed.

### Publication gates: all closed

- Project-code license — closed: Apache-2.0 owner-approved 2026-09-27
  (see `LICENSE`, `NOTICE.md`, `LICENSE-DECISION.md`).
- Upstream voice-code license — closed: the same owner approval covers
  the imported voice-plugin source (see `LICENSE-DECISION.md`; per-plugin
  `LICENSE` + `NOTICE.md` ship in both plugin packages).
- Cappi binary redistribution — closed: the original Cappi pack ships as
  the licensed `characters/cappi-original/` set (25 GIF files with
  per-file sha256 provenance, watch-app asset mirror, `registry.json`
  entry with `cappi-original` as the clean-checkout default) under the
  same owner-approved Apache-2.0.

## [0.2.0-rc0] — release candidate scaffolding (release toolchain)

### Added

- `tools/` release toolchain (stdlib Python + POSIX shell, no network):
  `verify.sh` single entrypoint, `scan-secrets.py` (filenames + contents,
  paths/counts only, archives included), `check-license-gate.py`
  (publication blocks, LOCAL candidates allowed), `export-source.sh`
  (reproducible allowlist export, `ALLOWLIST.txt`), `release-bundle.sh`
  (bundle + checksums into gitignored `dist/`), `sbom.py` (dependency /
  asset inventory with upstream metadata, no weights), `inspect-binaries.py`
  (metadata only), `validate-assets.py`, `installer-dryrun.sh` (isolated
  temp HOME), plus a `tools/tests/` unittest suite with runtime-generated
  fixtures.
- `.github/workflows/ci.yml`: Android (`testDebug`, `lintDebug`,
  `lintRelease`, unsigned `assembleRelease`), bridge Node 26 tests, plugin
  pnpm full checks, asset validation, installer dry-run on temp HOME,
  tools verification. Actions pinned to major-version tags.
- Root docs: `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `NOTICE.md`,
  `LICENSE-DECISION.md` (NOASSERTION record + Apache-2.0 proposal,
  unconfirmed), `VERSION`.
- `README.md`: first-run setup and compatibility guidance; Node 26 requirement.
- `tools/smoke-clean-source.sh`: clean-source smoke (extract local source
  archive to a temp dir, re-run bridge tests + tools verification there,
  prove no links to the working tree/install; no Gradle, no full plugin
  suites — those stay with owners A/D and CI).

### Fixed

- Stale `README.md` line calling `plugins/dsh-watch/` a "future … contract
  draft": it is an implemented, tested session-scoped tool.
- Stale `tools/` scaffold note ("owner TBD … do not scatter scripts").
- Corrected the documented bridge Node requirement to Node 26+.
- Removed unsafe implication that a token is "printed" at startup: routine
  bridge logs print the certificate pin (public pairing material), never
  the token.
- `LICENSE-DECISION.md` confirmation no longer asks for a personal
  name/date (owner approval without personal data); `VERIFY PASS` and
  `--artifacts` SHA wording no longer imply a closed publication gate
  or a release signature. (Component-version notes there are superseded
  by "Final packaging hardening" above: all components `0.2.0-rc0`.)

### Gates still open at that point (publication blocked)

- Cappi binary redistribution rights unresolved (characters area).
- Upstream voice-code license not explicitly granted — NOASSERTION
  (needs user grant).
- Project-code license unconfirmed — Apache-2.0 proposed, not confirmed
  (needs user confirmation).

Superseded follow-up: components were unified at `0.2.0-rc0` (see
"Final packaging hardening" above); the earlier "`watch-app` already
`0.2.0-rc0`, plugins still `0.1.0`" split no longer applies.
