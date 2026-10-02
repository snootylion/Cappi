# Asset license notes (publication gates)

No third-party or upstream license is invented anywhere in this tree.
The actionable permission record is `LICENSE-DECISION.md`: original
project code, the imported voice-plugin source, and the original Cappi
assets are owner-approved Apache-2.0 (2026-09-27). Third-party SDKs and
model weights retain their own terms.

## Cappi assets — licensed pack + legacy gate

The canonical licensed pack is `characters/cappi-original/` (pack JSON
with a 25-GIF per-file sha256 inventory, mirrored at
`watch-app/app/src/main/assets/characters/cappi-original/`), released
under Apache-2.0 on the basis of the owner's explicit permission (see
`LICENSE-DECISION.md`). Only that manifest-authorized, hash-verified
file set ships: the secret scan, asset validation, binary inspection,
and export allowlist enforce the path/hash inventory.

The legacy directory `watch-app/app/src/main/assets/cappi/` remains a
hard gate: only `README-GATE.md` may exist there. Any other file in it
(private restores, manifests, GIFs) fails the scan, the asset
validation, and the publication gate, regardless of the licensed pack.
Unknown binaries elsewhere remain blocked. The original private
prototype snapshot itself stays private and never ships.

## Voice plugin source — permitted

`plugins/dsh-live-voice/` derives from a private upstream snapshot (see
`IMPORT-NOTES.md`, `PROVENANCE.md`, `LICENSE-DECISION.md`).
Redistribution of that imported source under Apache-2.0 is permitted on
the basis of the owner's explicit permission (owner-approved
2026-09-27). Model/runtime assets fetched at install time keep their own
upstream/vendor terms.

## Example pack — safe default (unchanged)

`characters/example-pack/` is a superseded draft-v0 sketch (kept for
history, NOT loaded at runtime). The license-safe runtime defaults are
`characters/dot-default/` and `characters/ember-min/` — original,
minimal CC0-1.0 vectors declared in-pack — referenced by docs and the
watch asset mirrors alongside the licensed `cappi-original` pack hash
inventory shipped in-tree and verified.

## Not in this tree (by policy)

Model weights (Kokoro, summary, Pocket TTS — external opt-in downloads;
links and checksum docs inventoried by `tools/sbom.py`, never bundled),
voice-cloning weights, screenshots, user transcripts, logs,
keys, tokens, keystores, and build artifacts are never copied here.
