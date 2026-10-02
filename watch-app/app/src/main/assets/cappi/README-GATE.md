# assets/cappi — PROVENANCE GATE (publication blocked until rights close)

The Cappi prototype binaries (`*.gif` + `cappi-manifest.json`) were REMOVED
from this directory on 2026-09-27 (contributor B refactor). Their
redistribution rights are **unresolved**: they are local behavior-parity
material only and must not ship in any public artifact.

- Private local copies (if you need pixel-parity testing on your own
  workstation): `.release-work/local-assets/cappi/` — never committed.
- Restore locally with: `./characters/import-local.sh --from
  <private-dir> --to watch-app/app/src/main/assets/cappi`
  (validates the manifest + asset set first; refuses traversal-unsafe names).
- A clean checkout intentionally has NO `cappi-manifest.json` here. The avatar
  runs on the license-safe default character (`dot-default`, original CC0
  vectors) and never requires these files.

Do NOT re-add third-party or unresolved binaries to this directory to "fix" a
missing-file warning: add or select a cleared character pack under
`characters/` + `assets/characters/` instead.
