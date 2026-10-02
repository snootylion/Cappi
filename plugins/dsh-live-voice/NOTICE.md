# Notices for dsh-live-voice

This plugin is licensed under the Apache License, Version 2.0 (see
`LICENSE` in this directory; canonical text identical to the root
`LICENSE`). Copyright: `wear-dsh release contributors` (generic — no
personal names, emails, or handles are recorded by policy).

Plugin source here (including source derived from the private upstream
snapshot — see `IMPORT-NOTES.md`, `PROVENANCE.md`) is redistributed
under Apache-2.0 on the basis of the owner's explicit permission
(owner-approved 2026-09-27; see the root `LICENSE-DECISION.md`).

Third-party model/runtime assets (Kokoro, summary, Pocket TTS) are
never vendored: they download at install time behind
`--download-models`, and each asset's upstream repository/vendor terms
govern it. npm/pip dependencies resolve from their registries under
their own terms; lockfiles pin the exact versions.
