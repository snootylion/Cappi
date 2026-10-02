# License decision record

Status: **CONFIRMED — owner-approved Apache-2.0 for project code,
imported voice-plugin source, and original Cappi assets.**
Recorded without personal data — no name, email, or handle.

## Confirmed grants (owner approval, 2026-09-27)

The human owner explicitly approved:

- `release-code-license Apache-2.0` for original code in this release
  tree, with the original Cappi "I have the rights" statement; then
- clarification `Yes — Apache-2.0 for both`, authorizing the imported
  voice-plugin source AND the original Cappi assets under Apache-2.0.

Third-party SDKs and model weights retain their own terms (never
relicensed here).

CONFIRMED-BY-USER: Apache-2.0 owner-approved 2026-09-27

Scope of the Apache-2.0 grant: original code authored for this release
tree (bridge modules, `plugins/dsh-watch` sources and tests, release
tooling under `tools/`, original character-pack JSON under
`characters/`, original docs), the imported `plugins/dsh-live-voice/`
source, and the original Cappi artwork/pack JSON integrated as
`characters/cappi-original/` (+ its watch-app asset mirror). Rationale:
permissive, patent-grant, compatible with Gradle/Node plugin
distribution. The canonical license text ships as `LICENSE` (root) and
per-plugin `LICENSE` files for npm artifacts.

UPSTREAM-VOICE-GRANT: Apache-2.0 owner-approved 2026-09-27

The `plugins/dsh-live-voice/` source derives from a private upstream
snapshot (see `IMPORT-NOTES.md`, `PROVENANCE.md`). Redistribution of
that imported source under Apache-2.0 is permitted on the basis of the
owner's explicit permission above — this closes the `upstream-voice`
gate with a real grant, not an invention.

CAPPI-ORIGINAL-GRANT: Apache-2.0 owner-approved 2026-09-27

The original Cappi artwork and pack JSON integrated as the canonical
licensed pack `characters/cappi-original/pack.json` (25 GIF files with
per-file sha256 provenance, mirrored at
`watch-app/app/src/main/assets/characters/cappi-original/`) are released
under Apache-2.0 on the basis of the owner's explicit "I have the
rights" permission above. Only the manifest-authorized, hash-verified
file set ships: the export allowlist, secret scan, asset validation,
and binary inspection enforce the path/hash inventory, and arbitrary
restores in the legacy `assets/cappi/` directory (or unknown binaries
elsewhere) remain blocked. The original private prototype snapshot
itself stays private and never ships.

## Gates closed by these grants

- `project-license` — closed by `CONFIRMED-BY-USER` above.
- `upstream-voice` — closed by `UPSTREAM-VOICE-GRANT` above.
- `cappi-binaries` — closes only when, in addition to the grants above,
  the licensed-pack hash inventory is present and verified in the tree:
  `characters/cappi-original/pack.json` with the 25-file sha256
  inventory, all files hash-matching, identical watch-app mirrors, and
  a `registry.json` entry for `cappi-original`. That inventory now ships
  in-tree and verifies (see CAPPI-ORIGINAL-GRANT above and
  `characters/cappi-original/provenance.json`). Legacy private
  restores in `watch-app/app/src/main/assets/cappi/` (other than
  `README-GATE.md`) keep the gate open regardless.

## DSH SDK peer dependencies — own terms (unchanged)

The DSH `@deepseek-ai/*` packages are registry-resolved build/peer
dependencies, never vendored. Their terms govern their own artifacts;
review them at install time. Recorded here so no grant is implied.

## Model weights — never bundled, terms upstream (unchanged)

Kokoro / summary / Pocket TTS weights download at install time behind
`--download-models` (see `plugins/dsh-live-voice/PROVENANCE.md`). Each
asset's upstream repository terms govern it; model license links and
checksum docs are inventoried by `tools/sbom.py` as external references.
No weights ship in any bundle this toolchain produces.

## Component version note

The `0.2.0-rc0` label (see `VERSION`, `tools/VERSION`) is the release
bundle label, and all components are at `0.2.0-rc0`: `watch-app`
(`versionName`) and both plugins (`plugins/dsh-watch`, `plugins/
dsh-live-voice` manifests). Do not read the bundle label as anything
other than the coordinated component version.

## Template / example sources — own in-pack terms

Generic template and authoring-example sources in this tree (for
example `characters/example-pack/pack.json`) carry their own in-pack
`license` / `author` / `attribution` fields. Those fields are package
metadata as committed. The owner confirmation above governs original
project code, the imported voice-plugin source, and the original Cappi
assets as recorded; third-party and example-pack terms remain as
declared in-pack (or NOASSERTION where no grant exists) until the owner
explicitly confirms otherwise. Dependencies retain their upstream
metadata licensing — nothing here is blanket-marked Apache-2.0.
