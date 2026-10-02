# Notices for wear-dsh-release

This project is licensed under the Apache License, Version 2.0 (see
`LICENSE`). This file records attributions for material in the release
tree, per section 4(d) of that license. Nothing here invents a grant:
third-party terms are recorded as they are declared upstream, and the
actionable permission record lives in `LICENSE-DECISION.md`.

## Project

- `wear-dsh-release` — original code, docs, and character-pack JSON
  authored for this release tree by the release contributors, licensed
  under Apache-2.0 (owner-approved 2026-09-27; see `LICENSE-DECISION.md`).
- Copyright notice: `Copyright wear-dsh release contributors`.
  No personal names, emails, or handles are recorded here by policy.

## Character data

- `characters/dot-default/`, `characters/ember-min/` — original
  vector frames by the release contributors, declared in-pack as
  `CC0-1.0`. Those in-pack CC0 terms are retained and are unaffected
  by the project Apache-2.0 grant.
- `characters/cappi-original/` (licensed Cappi pack, integrated
  separately) — original Cappi artwork and pack JSON released under
  Apache-2.0 on the basis of the owner's explicit permission
  (owner-approved 2026-09-27; see `LICENSE-DECISION.md`). Shipped only
  as the manifest-authorized, hash-verified file set
  (`characters/cappi-original/pack.json` inventory + identical
  `watch-app/.../assets/characters/cappi-original/` mirror).
- `characters/example-pack/` — superseded draft-v0 sketch, kept for
  history, NOT loaded at runtime. Its in-pack terms stand as declared;
  no project-wide conclusion is invented about them.

## Imported plugin source

- `plugins/dsh-live-voice/` — voice-plugin source derived from a
  private upstream snapshot (see `IMPORT-NOTES.md`, `PROVENANCE.md`).
  Redistribution under Apache-2.0 is permitted on the basis of the
  owner's explicit permission covering that imported source
  (owner-approved 2026-09-27; see `LICENSE-DECISION.md`).

## Third-party material (own terms apply — not Apache-2.0)

- Gradle distribution (downloaded by the wrapper on first run; wrapper
  jar in-tree, see `tools/inspect-binaries.py`). Gradle is Apache-2.0
  upstream; verify against the distribution you download.
- DSH SDK `@deepseek-ai/*` packages (peer/dev dependencies of both
  plugins, pinned in `package.json` / `pnpm-lock.yaml`). Never vendored;
  their own registry terms apply.
- npm/pip transitive dependencies (lockfiles pin versions). Their own
  terms apply.
- External model assets (never bundled; opt-in download behind
  `--download-models`): `mlx-community/Kokoro-82M-bf16`,
  `cof139/G9v3-3B-mlx-4Bit`, Pocket TTS package/weights. Each asset's
  upstream repository/vendor terms govern it; checksums and links are
  inventoried by `tools/sbom.py` as external references.
