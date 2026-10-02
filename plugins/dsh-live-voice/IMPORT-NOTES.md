# IMPORT-NOTES

`plugins/dsh-live-voice/` was a verbatim source import from the private
upstream snapshot. Generalization is complete:

- `README.md` is the portable operator doc; `README.upstream.md` is now a
  pointer (machine-specific install narrative and verification records
  removed). `PROVENANCE.md` records asset revisions/checksums without
  inventing upstream licenses.
- `resources/install-*.sh` and `deploy-profile-plugin.sh` take configurable
  install roots (`--dsh-home`/`--profile`/`--runtime-root` + env), dry-run
  by default (`--apply` required), refuse live targets without `--allow-live`
  + `DSH_WATCH_MAINTENANCE_CONFIRM=1`, and download model assets only with
  explicit `--download-models`. Shared logic lives in
  `resources/install-common.sh`.
- `src/voice-defaults.ts` centralizes default providers, locale/voices, and
  model revisions; `describeVoiceHost()` reports honest per-host capability
  (macOS Apple silicon full, elsewhere degraded). Settings/trace/lease paths
  are env-overridable.
- `package.json` carries `license: Apache-2.0` with `LICENSE` + `NOTICE.md`
  included in the published `files` set (local-only packs; nothing is
  published from this tree). The Apache-2.0 grant covering this imported
  source rests on the owner's explicit permission (owner-approved
  2026-09-27; see the root `LICENSE-DECISION.md`).
- Model-weight downloads, hash manifests, and optional installs stay
  license-checked (see PROVENANCE.md); no weights are vendored here.
