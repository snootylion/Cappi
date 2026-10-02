# wear-dsh-release

Wear OS companion + local LiveVoice + Cappi DSH plugins, release candidate **0.3.0-rc0**. Default installation is managed inside vanilla DSH **0.1.2-rc.1**: install the LiveVoice tgz, then Cappi; use authenticated Mac Settings and the watch pairing wizard. **No manual bridge service, session ID, certificate, or token editing.** See [Onboarding](docs/ONBOARDING.md).

## Local review artifacts

- `*-debug-installable.apk`: generic Android **DEBUG/DEV signed**, fresh-install test candidate; **not production release signed**. Contains the existing exported debug-renderer probe/activity and in-process test factory seam; no production-hook-isolation claim.
- `*-release-unsigned.apk` (optional): standard release, **not R8-minified**, debuggable false and without those own debug hooks; requires the owner's signing key before installation.
- Two plugin npm tgz packages: prebuilt JS/client assets and a manifest-verified, ad-hoc-signed universal macOS watch-ASR helper (arm64 + x86_64, macOS 13+). Runtime installation needs no Xcode/CLT; building the clean source does.
- Allowlisted source archive, SHA256 checksums, source/asset SBOM and runtime artifact SBOM. No keystore, personal preferences, credentials, runtime consent/state, native privacy database, caches, node_modules, or model weights.

Current Android versionCode is 3. That does **not** establish upgrade compatibility with an existing physical watch: matching signing identity is also required. No original private keystore is used or supplied.

## Evidence and limits

Actual isolated full runs on Node **22.23.3** and **26.5.1**, using identical reviewed runtime packs, passed real native Apple Speech → fresh SDK user/turn → fixture-model reply → production system TTS (native 9/9), plus real no-speech/no-prompt, repeated-record readiness and scoped input cancellation. Actual SDK Cappi execution and model-requested approval/question callbacks completed in correlated fresh turns. Tests never use a user's microphone, live profile, credentials or physical watch. The private fixture disables external adapter routing; published default configuration is unchanged.

Node **22.19+** is the accepted support target; actual Node22 installation/boot/wire execution is required before matrix support is marked PASS. `--skip-node22` records only the printed current runtime. Native helper Intel support means a compiled x86_64 slice, not an actual Intel-runner test. First users still need normal OS permission grants and configured DSH model/provider access; the keyless fixture is not a real external provider.

One active watch per profile is supported. Generic Wear OS uses avatar touch long-press to open the menu; Samsung hardware-button shortcuts are device-specific. SDK rc.1 queue reordering is unsupported and advertised/disabled, not fake-successful. The refactored app's physical-watch validation and visual wizard/runtime testing remain separate from headless host-native acceptance; no blanket “just works” claim is made.

Original project code, imported voice-plugin source and the 25 original Cappi GIFs are owner-approved **Apache-2.0**; see `LICENSE`, `NOTICE.md` and `LICENSE-DECISION.md`. Registry/provenance/mirror hashes are verified; third-party SDKs and optional models retain their own terms. Legal inventory gate closure is **not** permission to publish/upload/deploy. Final candidate bundling remains subject to parent review; no commit or network publication is performed by this work.

## Verify

```sh
./tools/verify.sh
./tools/test-vanilla-install.sh --full --require-native
# Explicit actual-runtime-only acceptance (every CLI/pnpm/boot uses this node):
./tools/test-vanilla-install.sh --full --require-native --node-bin=/absolute/private/node --skip-node22
```

`VERIFY PASS` covers source/privacy/assets/licenses/SBOM/export/tests, not publication permission or physical-watch certification. Full acceptance uses isolated private homes, official DSH JS entry, ephemeral ports (never 3083/8787/8789), and generated fixtures. Wait for all builds/writers to finish before packing; the stable snapshot gate refuses concurrent source/build changes.

## Layout

- `watch-app/`: Wear OS Gradle project (`dev.dsh.watch`).
- `plugins/dsh-live-voice/`: local voice service and native source/build script.
- `plugins/dsh-watch/`: managed pairing, watch session controls and scoped Cappi tools.
- `bridge/`: optional advanced legacy adapter/source; not managed setup.
- `characters/`: character packs, canonical asset licensing/provenance.
- `protocol/`: schemas/transport contracts.
- `tools/`: verification, allowlist export, artifact provenance and CI support.
- `docs/`: onboarding and reference documentation.

Never commit secrets, keys, user logs/transcripts, screenshots, weights or build artifacts. Security rules: `SECURITY.md`; plugin details: `docs/plugins.md`; build commands: `docs/ONBOARDING.md`.
