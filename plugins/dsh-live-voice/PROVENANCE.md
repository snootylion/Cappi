# dsh-live-voice provenance

## Import source

`plugins/dsh-live-voice/` derives from a private upstream snapshot (exact
commit recorded in the private provenance log, not republished here).
Machine-specific install layouts, local verification records, and personal
paths from that snapshot were removed during generalization; behavior is
preserved. `README.upstream.md` now only points at the portable docs.

## Third-party assets (downloaded at install, never vendored)

| Asset | Pinned default | Verify |
|---|---|---|
| Kokoro TTS model | `mlx-community/Kokoro-82M-bf16` @ `a71e4d38…12b1c3c` | `resources/kokoro-model-sha256.txt` (`shasum -a 256 -c`) |
| Kokoro Python deps | `resources/kokoro-tts-requirements.lock` | `pip --require-hashes` |
| Local summary Python deps | `resources/mlx-summary-requirements.lock` | `pip --require-hashes` |
| Local summary model | `cof139/G9v3-3B-mlx-4Bit` @ `076ed58e…50f09cb` | revision-pinned fetch |
| Pocket TTS package | `pocket-tts==3.0.2` | pinned version |

Downloads require explicit `--download-models` opt-in on the installers.

## License notes

- Plugin source (including source derived from the private upstream
  snapshot) is licensed under Apache-2.0 on the basis of the owner's
  explicit permission (owner-approved 2026-09-27; see the root
  `LICENSE-DECISION.md`). The canonical text ships as `LICENSE` in this
  directory; notices are in `NOTICE.md`.
- Each asset above is fetched from its upstream repository at install
  time; that repository's terms govern it — review them before opting
  into the download.
- The optional voice-cloning weights for Pocket TTS are gated by their
  vendor's terms and are not required for the default voice; the installer
  does not fetch them.
- npm/pip dependencies resolve from their registries at build/install time
  under their own terms; lockfiles pin the exact versions.
- No model weights, voice-cloning weights, screenshots, transcripts, logs,
  keys, or tokens are vendored in this tree.
