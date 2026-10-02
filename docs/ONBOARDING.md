# Onboarding

## Install the local review candidate

Requirements: vanilla DSH **0.1.2-rc.1**, Node.js **22.19+** (accepted support target; the acceptance harness tests the actual runtime), pnpm 10, a Mac running macOS 13+, and a Wear OS watch. Configure a real model provider in DSH Settings before expecting real model replies. The keyless acceptance fixture is a test adapter, not a shipped provider or proof of an external model account.

1. Review the candidate checksums/SBOM and source provenance. Install `wear-dsh-0.3.0-rc0-debug-installable.apk` using your normal Android installation workflow. It is **generic Android DEBUG/DEV signed**, suitable for a fresh local test install, **not production release signed**. The optional `*-release-unsigned.apk` cannot be installed until the owner signs it. No original-watch upgrade is promised: matching signing identity and versionCode are required for updates (current versionCode is 3). No private keystore is supplied.
2. Install the two runtime packages with the **official DSH CLI**, LiveVoice first, then Cappi:

   ```sh
   dsh plugin --profile web add /path/to/dsh-live-voice-kokoro-0.3.0-rc0.tgz
   dsh plugin --profile web add /path/to/dsh-watch-0.3.0-rc0.tgz
   ```

   These commands are user installation steps, not commands that release tests run against a live profile. Tests invoke the official package's `lib/bin.js` in an isolated home, never a user wrapper. Start the normal DSH web profile after installation. The default managed plugins create their own scoped service; **no manual bridge process, service plist, session ID, certificate, or token entry is needed**.
3. Open the authenticated DSH Settings → Watch panel. Use its explicit voice setup/consent action. First-time users must grant **Mac Speech** permission for watch ASR; the **watch Microphone** permission is needed for watch capture. Mac Microphone permission is needed only for Mac/browser input, not generated-speech tests or watch-ASR setup. Permission denial must remain an actionable refusal, never a fake ready state. Setup does not bypass normal OS consent.
4. Use the watch pairing wizard and discovery on the same network. Compare the displayed fingerprint on **both** the watch and authenticated Mac Settings panel, then approve. Discovery is only a candidate hint; the watch verifies the actual TLS certificate before sending its enrolled device token. Manual host entry is a fallback in the wizard, not token/session editing.
5. Select a thread in the watch UI (or use its auto-follow option), then enable voice and test a short prompt. Model/provider configuration remains a prerequisite. The managed release supports **one active watch per DSH profile**; revoke/unpair before replacing it.

Avatar **touch long-press** opens the menu on generic Wear OS. Samsung Watch4 hardware button behavior is a device-specific shortcut, not a requirement for other watches. Physical-watch validation of this refactored release remains separate from host protocol tests and emulator evidence.

SDK capability limits are explicit: rc.1 does not support queue reordering, so managed capabilities report `queueReorder:false` and the watch disables it. Other controls must follow the advertised feature map; unsupported operations return an honest error, not success. Do not infer complete legacy feature parity.

## Native helper: installation versus building

The runtime LiveVoice tgz includes an ad-hoc-signed **universal arm64 + x86_64** `resources/bin/watch-asr`, its Swift source, Info plist, manifest, and build script. The manifest binds source/plist/binary SHA256 and header-parsed architectures, with minimum macOS **13.0**. Installing this prebuilt runtime does **not** require Xcode/CLT. Intel is a compiled-slice claim, not an actual Intel-runner test; native execution has been exercised only on the available Apple-silicon host. Already-granted Speech status can be diagnosed read-only without a new permission prompt.

Building from a clean source checkout on macOS requires Xcode command-line tools and a macOS SDK. Compiled native helpers are ignored and **excluded from the source archive**, then rebuilt before npm packing:

```sh
plugins/dsh-live-voice/scripts/build-watch-helpers.sh          # preview
plugins/dsh-live-voice/scripts/build-watch-helpers.sh --apply  # explicit build, no capture
```

No model weights, personal preferences, keystore, credentials, native permission database, consent/state files, node_modules, or build caches belong in a source/runtime artifact. Optional Kokoro/Pocket/model features retain their own installation and licensing requirements; the verified watch native chain uses production system TTS, not downloaded models.

## Clean source build and checks

Watch builds require Android SDK 35, JDK 17, and the Gradle wrapper (8.11.1). Each command below starts at repository root; build before plugin tests so deploy specs see the built `lib/` outputs. The pnpm lockfiles resolve the published rc.1 SDK, not a local SDK checkout.

```sh
(cd watch-app && ./gradlew :app:testDebugUnitTest :app:lintDebug :app:lintRelease :app:assembleDebug :app:assembleRelease)
(cd bridge && node --test *.test.mjs)  # optional advanced legacy adapter; not managed setup
(cd plugins/dsh-watch && npx --yes pnpm@10.15.1 install --frozen-lockfile)
(cd plugins/dsh-watch && npx --yes pnpm@10.15.1 run check)
(cd plugins/dsh-live-voice && npx --yes pnpm@10.15.1 install --frozen-lockfile)
plugins/dsh-live-voice/scripts/build-watch-helpers.sh --apply
(cd plugins/dsh-live-voice && npx --yes pnpm@10.15.1 run check)
./tools/verify.sh
```

CI checks plugin builds on actual Node 22.19.0 and 26 runtimes; native helper compilation/packed provenance checks run on macOS, never a Linux fake pass. The Ubuntu source-candidate job does not carry macOS runtime packages. CI artifacts are test/review outputs, not publication or deployment authorization.

## Isolated vanilla acceptance

```sh
./tools/test-vanilla-install.sh --doctor
./tools/test-vanilla-install.sh --full --require-native
# Pin every CLI/boot/pnpm descendant to a private runtime, not a version probe:
./tools/test-vanilla-install.sh --full --require-native --node-bin=/absolute/private/node --skip-node22
```

The script prints the actual Node executable/version and checks CLI drift against 0.1.2-rc.1. A default non-22 run must execute the **whole** private Node22 install/boot/wire child leg before a matrix PASS. If Node22 acquisition is unavailable the matrix remains PENDING; a version probe never earns support. `--skip-node22` explicitly narrows evidence to the actual current runtime, not the whole matrix.

Full native acceptance requires read-only packed-helper status `authorized`, explicit setup consent, generated speech PCM (never user microphone), a matching native stream/utterance final, that exact text in a **new** durable host user record after a pre-native cursor, a **new completed** fixture assistant turn, and matching production TTS speechId/chunks on watch SSE. The registered SDK Cappi tool must update dance state and SSE, not just pass an HTTP clear request. Real approval/question callbacks require a fresh SDK user/turn/model tool-call, matching durable result and completion. Silence must return actual no-speech/ACK0 without a new prompt; repeated RECORD after EOF/no-speech must be ready without setup/synthesis, and scoped input cancellation must reject retired stream reuse. Prior snapshots/replies cannot satisfy these checks. The private test-only overlay isolates UDP discovery and disables the default external adapter; published defaults remain unchanged.

`FULL PASS` (exit 0) is host protocol/native evidence under the printed runtime scope; it is **not** a physical-watch, real external-provider, or visual setup-wizard certification. `ROUTING_PASS`/PENDING (exit 3) cannot claim native delivery; `--require-native` makes pending native legs fail (exit 1). No tests bind production ports 3083/8787/8789, read live DSH credentials/logs, start user microphones, or change an installed user profile.

Post-hardening isolated full runs passed on actual Node **22.23.3** and **26.5.1**, using identical immutable runtime packs on an already-authorized Apple-silicon Mac: native 9/9, real no-speech, repeat-record readiness and scoped cancellation. Separate real SDK browser checks verified the Watch Settings pairing/approval/revoke panel (not just an asset/SSR check); blocked legacy compatibility probes remain a reported limitation. First-user OS consent, physical-watch validation and real external-provider access are not certified by these tests. Final source/artifact evidence still requires review before publication.

## Advanced legacy path

`bridgeMode:"legacy"` is an opt-in compatibility/test adapter. Its manual certificate/token/service configuration is documented in the bridge/plugin references; it is **not** the default installation workflow above. Legacy standalone source may be present in the source export; it is not a managed runtime dependency. Never put personal LAN addresses, tokens, or typed session IDs into the checked-in examples.
