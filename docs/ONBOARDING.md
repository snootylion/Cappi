# First-time setup

## Before you start

This is the normal user path, not the contributor/build path below. The validated combination is an **M5 MacBook Pro** running macOS 13+ and a **Galaxy Watch4**. Other Macs, Wear OS models, Android installation methods, or DSH versions may need minor adaptation; do not assume Samsung-specific button shortcuts work elsewhere.

You need all of the following before starting:

- **DeepSeek Harness (DSH) 0.1.2-rc.1** installed and open. This repository does not install DSH itself. Confirm the `dsh` CLI is available, use the profile you normally run (the examples use `web`), and configure a real model provider in DSH Settings.
- **Node.js 22.19+** on the Mac. Node is required by DSH and the plugins; pnpm 10 is needed only when building from source.
- A **Wear OS watch** on the same local network as the Mac. The documented hardware is Galaxy Watch4; generic Wear OS uses touch controls.
- A matching set of three maintainer-provided install files from the **same build**: the DEBUG/DEV APK, `dsh-live-voice-kokoro-0.3.0-rc0.tgz`, and `dsh-watch-0.3.0-rc0.tgz`, plus their checksums. GitHub Actions artifacts are review outputs, not a signed end-user release.

> The keyless acceptance fixture is test-only. It is not a model provider, an external-model account, or a substitute for configuring DSH.

## First-time setup

### 1. Install and open DSH

Install DeepSeek Harness **0.1.2-rc.1** through its normal official distribution, open the profile you plan to use, and configure its model/provider access. Do this before pairing the watch: a paired watch can connect without a provider, but it cannot receive real model replies until the DSH profile is configured.

### 2. Install the watch APK

Review the APK checksum, then install the matching `wear-dsh-0.3.0-rc0-debug-installable.apk` on the watch using your usual Wear OS/Android installation workflow. It is **generic Android DEBUG/DEV signed** for a fresh local test install; it is **not production release signed**. The optional `*-release-unsigned.apk` cannot be installed until the owner signs it.

Do not expect this APK to update an already-installed copy: Android requires the same signing identity as the existing app (the current versionCode is 3), and no private keystore is supplied. If you are adapting the workflow for another watch or Android version, use that platform's normal installation instructions rather than bypassing its security prompts.

### 3. Install the DSH plugins

In Terminal on the Mac, replace `web` if your DSH profile uses another name. Install **LiveVoice first**, then Cappi:

```sh
dsh plugin --profile web add /path/to/dsh-live-voice-kokoro-0.3.0-rc0.tgz
dsh plugin --profile web add /path/to/dsh-watch-0.3.0-rc0.tgz
```

Restart or start that normal DSH profile after both commands succeed. Do **not** start a separate bridge process or edit a service plist, session ID, certificate, or token: managed mode creates the scoped local service itself.

### 4. Give only the required permissions

Open authenticated **DSH Settings → Watch** and select the voice setup/consent action. Grant **Mac Speech Recognition** for watch ASR and **Microphone** permission on the watch for watch capture. Mac Microphone permission is needed only for Mac/browser input, not for watch-ASR setup. If a permission is denied, use the displayed remediation rather than treating the backend as ready.

### 5. Pair the watch securely

On the watch, use the pairing wizard while both devices are on the same network. Select the discovered Mac, compare the displayed fingerprint on the **watch** and in **DSH Settings → Watch**, then approve on the Mac. Discovery only suggests a candidate; the watch verifies the actual TLS certificate before sending its enrolled device token. Manual host entry is a wizard fallback, never an instruction to copy a token or session ID.

### 6. Confirm it works

Select a thread in the watch UI (or enable auto-follow), enable voice, and send a short prompt. The managed setup supports **one active watch per DSH profile**; revoke/unpair it before pairing a replacement. On generic Wear OS, touch-hold the avatar to open the menu. Galaxy Watch4 button behavior is an optional device-specific shortcut.

## What this setup does not promise

- It has been tested on an M5 MacBook Pro and Galaxy Watch4; other systems may need minor adaptation.
- SDK rc.1 does not support queue reordering, so the watch disables that feature (`queueReorder:false`).
- The DEBUG/DEV APK is for fresh local testing, not a production-signed distribution.
- Physical watch behavior and visual wizard flow differ across manufacturers; normal OS permission, pairing, and installation policies still apply.

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
