# WORKPLAN (public, generic)

Task list by area. No personal paths, hosts, or credentials. Turnkey
candidate is `0.3.0-rc0` (`watch-app` `versionName`, both plugins
(`package.json`), and the release bundle label (`VERSION`,
`tools/VERSION`)). Older `0.2.0-rc0` notes below describe the pre-turnkey
baseline only.

## Device/app (`watch-app/`, except `cappi/**`, `ui/AvatarScreen.kt`, `net/**`, `service/**`, `core/ViewModel.kt`)

- [ ] Own `MainActivity.kt` navigation (normal grid entry + `RemoteHomeActivity`
      alias), all `ui/*` screens except `AvatarScreen`, `device/**` (new),
      `util/**`, manifest, `settings.gradle`/`build.gradle`, `App` singleton.
- [ ] Preserve: single process-scoped `BridgeViewModel` via `App`
      (`ViewModelStoreOwner`), one SSE connection per process, watch4 +
      generic profiles.
- [ ] Keep `net/**`, `service/**`, `core/ViewModel.kt`, `cappi/**` edits in
      their own area below; coordinate build/manifest requirements instead
      of editing across areas.
- [ ] Document device adapter APIs (haptics, wake controller) in
      `watch-app/app/src/main/java/dev/dsh/watch/util/`.

## Characters (`watch-app/.../cappi/**`, `ui/AvatarScreen.kt`, `characters/`, `protocol/character-pack.schema.json`)

- [ ] Migrate pack data to role-based dimensions with fallbacks; keep existing
      transitions and authoritative speech/question behavior.
- [ ] Expose a backward-compatible facade so `MainActivity`/`ViewModel` need
      no edits; ship `characters/example-pack/` as the no-core-edit demo.
- [ ] Keep `MainActivity`, `ViewModel`, and bridge edits in their own areas.
- [ ] Gate: licensed Cappi pack hash inventory landed — the approved
      `cappi-original` pack (25 GIF files with per-file sha256 provenance
      + watch-app mirror + registry entry, default selection) ships in
      this tree (see `docs/ASSET-LICENSE-NOTES.md`, `LICENSE-DECISION.md`).
      Legacy private restores stay blocked.

## Transport/bridge (`bridge/`, `watch-app/.../net/**`, `service/**`, `core/ViewModel.kt`, their tests, `protocol/` transport)

- [ ] Secure pairing: pinned HTTPS, manual address entry, UDP discovery
      treated as untrusted, token in `X-Bridge-Token` header (never URL).
      Explicit insecure legacy (cleartext LAN) mode only if needed, behind a
      visible flag.
- [ ] Tests free of live credentials; loopback fixtures only.
- [ ] Split DSH adapter from voice adapter; cancellation safety on
      disconnect; configuration free of personal addresses.
- [ ] Define endpoint migration for Settings (current placeholder default is
      `http://192.0.2.1:8787`, RFC 5737 — replace with the migration UX, not
      a real host). Keep manifest/build edits in the device/app area,
      cappi models and UI in theirs.

## Voice/plugins (`plugins/**`, tests, installers, docs)

- [ ] Generalize `plugins/dsh-live-voice/` installers to configurable paths;
      installers must dry-run by default and refuse the current live target.
- [ ] Package the character tool contract (`plugins/dsh-watch/`) as a real
      testable plugin using available DSH APIs with explicit session scope
      (watch-linked session only).
- [ ] Preserve voice ownership / ASR draft distinctions, native routing,
      optional model installs, license checks. No unsupported rewrites.
- [ ] No changes to any live DSH installation from this tree.

## Release toolchain + root docs (done)

- [x] Root docs, release tooling under `tools/`, CI, versioning,
      publication checklist including the Cappi hash-inventory gate.
- Turnkey `0.3.0-rc0` in progress: `tools/test-vanilla-install.sh`
  (`--doctor|--probe|--full`) is the vanilla acceptance harness (official
  DSH JS entry, isolated temp home, ephemeral ports, keyless). `--probe`
  passes without H/V; `--full` packs H/V from source and drives the real
  pairing/device/mic wire with per-leg PASS/PENDING/BLOCKED verdicts —
  full integration is NOT claimed until `--full` reaches FULL PASS.
  Native helper is arm64-only (no universal payload yet); OS Speech
  recognition needs a user TCC grant and is a separate consent leg.
- All components at `0.2.0-rc0` (bundle label in `VERSION` /
  `tools/VERSION`, `watch-app` `versionName`, both plugin manifests).
  (Superseded by the `0.3.0-rc0` turnkey line above; kept for baseline.)
- Publication gates enforced by `tools/check-license-gate.py` /
  `tools/release-bundle.sh`: project-code and upstream voice-code grants
  — Apache-2.0 owner-approved 2026-09-27 (closed); licensed Cappi
  `cappi-original` hash inventory — landed in this tree
  (`characters/cappi-original/` + provenance + watch-app mirror +
  registry entry, default selection; closed — see `LICENSE-DECISION.md`).

## Verification state (actual, not aspirational)

- Done: `tools/verify.sh` (scan + assets + binaries + gate status + SBOM
  + export dry-run + tools tests), clean-source smoke
  (`tools/smoke-clean-source.sh`: extract local archive to temp dir,
  re-run bridge + tools checks there, prove no links to the working
  tree). Heavier suites run in CI (`.github/workflows/ci.yml`).
- Done: `watch-app` `0.2.0-rc0` unit tests 290/290, `lintDebug` +
  `lintRelease` 0 errors, unsigned release APK (debug-only render probe
  excluded from release), plus 11/11 instrumented render tests on a phone
  emulator (non-Wear Pixel, NOT a watch).
- Done: bridge Node loopback tests 121/121; `plugins/dsh-watch` 75/75;
  `plugins/dsh-live-voice` 137/137. Isolated installer plan-mode
  dry-runs.
- NOT done: on-watch validation of the NEW refactored tree. The only
  Watch4 hardware evidence covers the OLD pre-refactor baseline; the
  refactor is UNVERIFIED on Watch4/Wear hardware. No production,
  hardware, or legal validation is claimed, and no live-DSH
  compatibility is claimed (installers refuse live targets; validation
  is loopback/emulator only).
- `VERIFY PASS` from `tools/verify.sh` means the checks above passed; it
  does not close the publication gates. Local `--artifacts` bundles are
  unsigned local-only outputs — `.sha256` sidecars are integrity hashes,
  not release signatures.
