# dsh-live-voice — local live voice for DeepSeek Harness

On-device Apple Speech capture, Kokoro/Pocket TTS, contextual holding
phrases, and private continuation summaries. See `docs/plugins.md` for the
shared installer safety rules and PROVENANCE.md for asset origins.

## What it preserves

- The signed Apple Speech helper keeps microphone capture, adaptive VAD,
  pre-roll, partial/final transcripts, and on-device recognition on the host
  Mac.
- Final transcripts enter the current harness session through its native
  session route. Busy sessions use harness steering; idle sessions queue a
  normal turn.
- Kokoro remains the default warm TTS runtime; Pocket TTS is an optional
  CPU-only backend selectable through configuration.
- Sentence audio starts while the assistant response is still streaming.
  Code, URLs, paths, and Markdown are removed before speech.
- The first sentences of the final assistant block speak immediately; a
  ready private summary may replace only the still-unstarted remainder. A
  sentence that has audibly started always finishes.
- A private contextual holding provider produces one topic-aware process
  clause; a deterministic canned library is the cold/unavailable fallback.
- Meaningful partial recognition barges in: queued/current TTS is cancelled
  without cancelling the harness run.
- Mute keeps the session and warm model alive. Runtimes shut down after
  their idle timeouts.
- Summarization defaults to a local model over a direct pipe (no session
  history, no network port, no visible transcript). A harness-LLM route is
  an explicit configuration override and still requires reasoning off.

## Install (review first; dry-run is the default)

```bash
npx --yes pnpm@10.15.1 install --frozen-lockfile
./resources/install-live-voice-runtime.sh --apply --download-models
./resources/install-mlx-summary.sh --apply --download-models
./resources/deploy-profile-plugin.sh --apply
# Optional floating panel launcher (desktop app bundle):
./resources/install-shared-desktop-launcher.sh --apply
```

All installers print their plan without `--apply`, take configurable
`--dsh-home`/`--profile`/`--runtime-root` paths, refuse live targets
without `--allow-live` + `DSH_WATCH_MAINTENANCE_CONFIRM=1`, and download
model assets only with `--download-models` (see PROVENANCE.md for the
pinned revisions, checksums, and license notes). Restart the harness after
deploying; approve the local Microphone / Speech Recognition prompts on
first launch. Audio stays on the host.

### Liveness policy (explicit)

A target counts as *live* — real, possibly-running Harness state — when its
canonical path sits inside `$HOME/.dsh` for the current `$HOME`, inside
`~/.dsh` for the OS-recorded home of the current user id (immune to a
sandboxed `$HOME` or an inherited `$DSH_HOME`), or already contains harness
runtime markers (`sessions/`, `sessions.json`, `settings.yaml`,
`settings.json`). An existing profile/plugin directory **alone** is not
liveness: review and test homes pre-create it. Installer defaults always
resolve to a live target, so a bare `--apply` refuses without `--allow-live`
plus `DSH_WATCH_MAINTENANCE_CONFIRM=1`. Profile paths are additionally
confined to the selected DSH home: `..` segments and symlinked parents
cannot escape it (`require_within`). Nothing here ever deploys to, or
mutates, a live profile by automation.

## Configuration

All defaults live in `src/voice-defaults.ts` and are overridable in
`cordis.patch.yml` (only override what differs):

```yaml
- id: live-voice-kokoro
  config:
    ttsBackend: kokoro        # or: pocket (restart to compare)
    voice: af_heart           # kokoro voice
    # pocketVoice: alba       # pocket voice
    # locale: en-US           # default: $DSH_LIVE_VOICE_LOCALE, else system locale, else en-US
    endTurnMs: 1500           # 900–2500
    speechRate: 1.0           # 0.8–1.2
    acknowledgementDelayMs: 250
    holdingPhraseProvider: local-mlx  # or: canned (zero-latency safe library)
    holdingPhraseDelayMs: 550 # 250–1500
    holdingPhraseDiagnostics: false
    summaryBackend: local-mlx # or: harness-llm (explicit remote opt-in)
    # summaryProvider: openai-codex
    # summaryModel: gpt-5.4-mini
```

Environment overrides: `DSH_LIVE_VOICE_ROOT`, `DSH_LIVE_VOICE_LOCALE`,
`VOICE_SETTINGS_PATH`, `DSH_KOKORO_SUMMARY_ROOT`,
`DSH_KOKORO_SUMMARY_MODEL_PATH`, `DSH_LOCAL_MLX_LEASE_PATH`,
`DSH_HOLDING_TRACE_PATH`.

## Host support

macOS on Apple silicon is fully supported. Other hosts degrade honestly
(`describeVoiceHost`, surfaced as `host` on the status route): the Apple
Speech helper and MLX runtimes are unavailable off-macOS/Intel, leaving the
client UI plus explicit remote summary opt-in.

## Verify

```bash
npx --yes pnpm@10.15.1 install --frozen-lockfile
npx --yes pnpm@10.15.1 run check
# ...or step by step in clean order (build before test: the deploy spec
# stages lib/ outputs, so test-before-build fails on a fresh checkout):
# npx --yes pnpm@10.15.1 run typecheck
# npx --yes pnpm@10.15.1 run build
# npx --yes pnpm@10.15.1 run test
```

Tests use mocks, fixtures, and temp roots only — never the live profile,
never the microphone. A real-model smoke (optional, needs installed
runtimes) pipes `warm`/`speak` commands into the sidecars; it emits no
audio without an active session.

## License / provenance

Plugin source here is licensed under Apache-2.0 (see `LICENSE`; notices
in `NOTICE.md`) on the basis of the owner's explicit permission covering
the imported source (owner-approved 2026-09-27; see the root
`LICENSE-DECISION.md`). Third-party model/runtime assets are never
vendored (see PROVENANCE.md — upstream/vendor terms govern them; no
licenses are invented there). Nothing here is published from this tree;
installable packs are local-only build outputs.

## Authenticated HTTP and watch consent

All `/dsh-kokoro-live-voice/*` routes, including SSE, status and summary
release, require the DSH `connection` service (SDK `0.1.2-rc.1`). Its real
Host/Origin/session gate runs before any backend handler: anonymous requests
return 401; foreign Origin requests return 403. Browser same-origin fetch and
EventSource keep using the genuine DSH browser session. POST requires bounded
JSON (64 KiB, depth 64), application/json, and no duplicate keys, including
escaped or nested keys. Summary release takes a JSON object (`{}`).

The managed two-plugin watch path uses the in-process `ctx.liveVoiceWatch`
service: no HTTP cookie is needed for that internal service. Legacy standalone
bridges and the optional floating native panel cannot use unauthenticated raw
HTTP to the voice routes anymore. Advanced compatibility requires a genuine
authenticated DSH transport/session; no loopback exception, manufactured cookie
or token is provided. The managed watch path is the default supported path.

Watch consent is explicit: only a user Setup action calls `setup({consent:true})`.
Successful watch-Speech setup persists a non-secret versioned consent record at
`$DSH_HOME/live-voice-watch/consent.json` (default DSH home: `~/.dsh`). This is
**DSH-home/machine watch-Speech consent**, not per-profile or Mac-microphone
consent. Configure absolute `watchConsentPath` for separate genuine profile
storage; service embedders/tests can inject `consentPath` (omitting it is
memory-only). The directory must be owned 0700 and the regular file owned 0600;
symlinks, linked files, unsafe existing permissions and invalid records fail
closed. Writes use unique O_EXCL/O_NOFOLLOW temporary files and atomic rename.
`setup({consent:false})` durably revokes and stops active capture.

After restart, saved consent restores only after the shipped manifest matches
and read-only helper `--status` confirms authorized Speech, the same configured
locale, and available on-device recognition. It never runs `--authorize` or
capture to restore; denied permission, changed locale, malformed state or a
missing/tampered helper stays warming/error. Locale follows explicit settings,
then the detected system locale; unsupported on-device packs need owner action.

Native `ready`/read-only status validates permission and configuration, not a
guarantee that every Mac has the necessary OS language assets. Actual
non-cancellation recognition request failures emit `recognition-failed`, clear
the input lease and report actionable Speech/Dictation language-pack guidance.
No automatic OS pack or third-party model download is attempted.

Internal `createInput({purpose:'dictation', ...})` preserves deliberate draft
answers (including “yes”/“done” after a spoken question); drafts never submit by
this service. Default `purpose:'prompt'` retains bounded playback-echo filtering
and explicit interruption words. The host owns cancellation of playback when
an explicit dictation recording starts. This is an internal API option, not a
new unauthenticated route or wire field.

A fresh explicit recording stream also clears completed prior-reply echo
references for normal prompts: deliberate “yes”/“ready”/“done” must not vanish
for 30 seconds after a reply. Synthesis during the same ongoing capture still
seeds the bounded echo filter. Busy/failed acquirers cannot clear the active
owner's references; the host stops prior playback on explicit record.

Normal EOF, no-speech or intentional cancellation closes that validated watch
recording, not the reusable service: with consent intact, the backend returns
`ready` for another explicit record without Setup or TTS. Per-input no-speech
and cancellation events remain explicit. Disposal stays `closed`, revocation
stays consent-required, and native permission/locale/helper failures stay
fail-closed (including failures after a final receipt).
