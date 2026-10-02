# Cappi for DeepSeek Harness

Use Cappi to connect a Wear OS watch to DeepSeek Harness (DSH). You can talk to DSH from the watch, see Cappi on the watch, and print the optional ring mount.

## What you need

- A Mac running macOS 13 or later
- DeepSeek Harness (DSH) version 0.1.2-rc.1, installed and working with a model provider
- Node.js 22.19 or later
- A Wear OS watch and the Mac on the same Wi-Fi network
- Three matching install files supplied by the project maintainer:
  - the watch app APK
  - `dsh-live-voice-kokoro-0.3.0-rc0.tgz`
  - `dsh-watch-0.3.0-rc0.tgz`

This repository does not install DSH for you, and it does not currently provide an automatic end-user download. Install DSH using its normal instructions, then get the matching app and plugin files from the project maintainer.

## Set it up

### 1. Open DSH

Install and open DeepSeek Harness. Set up your model provider in DSH first. The watch can pair before this is done, but it cannot get real replies until DSH is ready.

### 2. Install the watch app

Install the supplied APK on the watch using your normal Wear OS or Android installation method. If the watch already has an older copy of this app, remove it first unless it was installed with the same signing key.

### 3. Install the two plugins

On the Mac, open Terminal. Replace `web` below if you use a different DSH profile. Install LiveVoice first, then Cappi:

```sh
dsh plugin --profile web add /path/to/dsh-live-voice-kokoro-0.3.0-rc0.tgz
dsh plugin --profile web add /path/to/dsh-watch-0.3.0-rc0.tgz
```

Restart DSH after both commands finish. You do not need to start another service or copy any tokens, certificates, or session IDs.

### 4. Allow permissions

In DSH, open **Settings → Watch** and start voice setup. Allow Speech Recognition on the Mac and Microphone access on the watch when asked.

### 5. Pair the watch

Make sure the Mac and watch are on the same Wi-Fi network. On the watch, open the pairing wizard and select the Mac. Check that the fingerprint shown on the watch matches the one in **DSH Settings → Watch**, then approve it on the Mac.

### 6. Try it

Choose a conversation on the watch, turn on voice, and send a short prompt. On most Wear OS watches, touch and hold the avatar to open its menu.

Only one watch can be connected to a DSH profile at a time. Unpair the old watch before connecting a different one.

## Size and print the ring

The optional ring mount is in [`designs/parametric-watch`](designs/parametric-watch/README.md). Open the Blender file, choose your inner finger diameter, export the ring-only OBJ, and print a small fit test before printing the final part.

## Compatibility

This setup was tested on an **M5 MacBook Pro** and a **Galaxy Watch4**. Other Macs, Wear OS watches, Android installation methods, and DSH versions may need small adjustments. Galaxy Watch4 buttons are optional shortcuts; use the touch controls on other Wear OS watches.

## If something does not work

- **`dsh` command not found:** install or reopen DeepSeek Harness so its command-line tool is available.
- **The watch cannot find the Mac:** check that both are on the same Wi-Fi network, then use the manual host option in the pairing wizard.
- **Pairing does not complete:** confirm that the two fingerprints match before approving.
- **Voice is unavailable:** return to **DSH Settings → Watch** and complete the permission prompts.

For technical details, source builds, and contributor information, see [`docs/`](docs/).
