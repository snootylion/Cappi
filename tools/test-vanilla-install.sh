#!/bin/sh
# tools/test-vanilla-install.sh — independent vanilla acceptance (P-owned).
# SPDX-License-Identifier: Apache-2.0
#
# Scope: vanilla macOS DSH `web` profile only. Installs via the OFFICIAL
# DSH JS CLI entry (never the user-env launcher shim), into an ISOLATED
# temp DSH_HOME, keyless boot on EPHEMERAL ports (never production
# 3083/8787/8789), with self-owned process cleanup. No live DSH, no live
# profile/plugin/bridge changes or restarts, no live credentials/logs/mic
# or physical-device interaction. All runtime config/private-key/token
# material stays OUTSIDE the checkout (temp dir, mode 600/700).
#
# Modes:
#   --doctor   print exact prerequisites + first-user guided steps, run no boot.
#   --probe    keyless vanilla probe (synthetic probe bundle only; passes
#              even when H/V turnkey bundles are unfinished). Default.
#   --full     full turnkey acceptance: builds TWO plugin tgz FROM SOURCE
#              (dsh-watch + dsh-live-voice, via private snapshot copies +
#              `npm pack --ignore-scripts --offline`), installs via the
#              official CLI, then drives the REAL frozen wire (browser
#              launch-token login, admin gates, provisional-cert pairing,
#              device auth, mic preflight, SSE) on ephemeral ports with
#              explicit fixtures. `--watch-tgz/--voice-tgz` remain as
#              overrides for parent-supplied packed-from-source tars.
#              A THIRD bundle — a deterministic fixture LLM plugin built in
#              private temp ONLY (official `ctx.llm.registerAdapter` +
#              real `sessionController` list/create/prompt/page/follow, no
#              external keys, no API gateway) — proves HOST_LLM routing:
#              the synthetic user phrase becomes a durable agent user
#              record and the fixed fixture echo returns as assistant
#              text. Fake ASR routing never claims native capture.
#              Legs that need live user state (a real session, OS Speech
#              TCC) report PENDING with the exact reason — never fake PASS.
# Flags:
#   --require-native   conservative: any pending NATIVE leg (helper
#              staging, mic-ready admission, OS recognition) fails the run
#              (exit 1) instead of the default ROUTING_PASS (exit 3).
#   --node-bin PATH   selects the actual runtime for ALL CLI/boot/pnpm descendants.
#   --skip-node22      explicit current-runtime-only evidence; default non-22
#              runs acquire private Node22 and execute the COMPLETE child leg.
#
# Verdicts (--full): FULL PASS (exit 0) only when routing AND native legs
# are green; NATIVE_PASS requires the packed-helper --status gate
# (authorization=authorized, localeAvailable + onDeviceRecognition true)
# followed by authed POST /admin/voice/setup {consent:true} -> ready, a
# bound-session mic/start 200, a GENERATED-speech PCM upload (system `say`
# "turnkey voice check" + 1s silence pad, never sine, never mic capture)
# with receipt ackFinals>=1 + delivered, a durable user record admitted via
# the real host prompt, a fixture-model assistant reply, and production
# system-TTS speech-started/audio(pcmBase64>0)/audio-done over the live
# watch SSE. ROUTING_PASS (exit 3) when HOST_LLM routing is proven but a
# native leg stays pending/blocked (fake-ASR routing is labelled, never
# native); PENDING/BLOCKED (exit 3) otherwise; FAIL (exit 1) on any wrong shape,
# with --require-native also on any pending native leg.
#
# Env scrub: every DSH_*/BRIDGE_* inherited variable is cleared before any
# subprocess; temp HOME/DSH_HOME/XDG_STATE_HOME/BRIDGE_STATE_DIR are then
# injected. NEVER run a bare `dsh` against the real ~/.dsh.
#
# Model note: keyless `modelCatalog` (zero routable real providers) is the
# supported PASS state for --probe/--full without keys. A real user DSH
# model-provider setup remains an EXISTING prerequisite owned outside this
# tree; this script never invents credentials. When a model string is
# needed, the exact OpenRouter id `meta/muse-spark-1.3-contributor` is used
# and `reasoning=xhigh` is NEVER passed (unsupported). The --full routing
# leg uses ONLY the temp fixture provider `fixture-local` + model
# `fixture-echo-1` (synthetic, harness-built, never shipped).
#
# Usage:
#   ./tools/test-vanilla-install.sh [--doctor|--probe|--full] [--watch-tgz PATH] [--voice-tgz PATH] [--js-entry PATH] [--require-native] [--node-bin PATH] [--skip-node22] [--keep-tmp]
set -eu

# Strict ambient environment allowlist BEFORE any Node/npm/SDK subprocess.
# Unknown provider/API/token/password/SSH/git/proxy variables are dropped;
# inspect NAMES only, never log values. HOME never points at the user profile.
for _env_key in $(env | cut -d= -f1); do
  case "$_env_key" in
    PATH|TMPDIR|LANG|LC_*|APKSIGNER|ANDROID_HOME|ANDROID_SDK_ROOT|JAVA_HOME) ;;
    *) unset "$_env_key" 2>/dev/null || true ;;
  esac
done
export HOME=/tmp

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MODE="--probe"
WATCH_TGZ=""
VOICE_TGZ=""
JS_ENTRY_OVERRIDE=""
REQUIRE_NATIVE=0
SKIP_NODE22=0
NODE_BIN=""
KEEP_TMP=0

# Parse paired and =value forms once; missing values fail closed.
_prev=""
for arg in "$@"; do
  if [ -n "$_prev" ]; then
    case "$_prev" in
      --watch-tgz) WATCH_TGZ="$arg" ;;
      --voice-tgz) VOICE_TGZ="$arg" ;;
      --js-entry) JS_ENTRY_OVERRIDE="$arg" ;;
      --node-bin) NODE_BIN="$arg" ;;
    esac
    _prev=""; continue
  fi
  case "$arg" in
    --doctor|--probe|--full) MODE="$arg" ;;
    --require-native) REQUIRE_NATIVE=1 ;;
    --skip-node22) SKIP_NODE22=1 ;;
    --watch-tgz=*) WATCH_TGZ="${arg#--watch-tgz=}" ;;
    --voice-tgz=*) VOICE_TGZ="${arg#--voice-tgz=}" ;;
    --js-entry=*) JS_ENTRY_OVERRIDE="${arg#--js-entry=}" ;;
    --node-bin=*) NODE_BIN="${arg#--node-bin=}" ;;
    --keep-tmp) KEEP_TMP=1 ;;
    -h|--help)
      sed -n '1,60p' "$0" >&2; exit 0 ;;
    --watch-tgz|--voice-tgz|--js-entry|--node-bin) _prev="$arg" ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done
[ -z "$_prev" ] || { echo "missing value: $_prev" >&2; exit 2; }

FORBIDDEN_PORTS="3083 8787 8789"

# --doctor: exact prerequisites + guided first-user steps. No boot. ------
doctor() {
  cat <<'EOF'
doctor: vanilla turnkey prerequisites (exact commands, no manual cert/token/sessionIDs)
  node --version            # need 22.19+ / 24 / 26 (never 26-only)
  pnpm --version            # required by `dsh plugin` (spawnSync pnpm)
  <js-entry> --version      # expect 0.1.2-rc.1 (vanilla SDK rc.1)
  <js-entry> --profile web --dump-default-config | grep -E 'session-controller|workspace-controller|webserver|settings-controller'
  # JS entry resolution (never the user wrapper):
  #   1. --js-entry=/absolute/package/lib/bin.js when explicitly pinned, else
  #   2. node package anchor: $(npm root -g)/@deepseek-ai/dsh/lib/bin.js, else
  #   3. well-known install path /opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
  # NEVER /opt/homebrew/bin/dsh (user-env launcher shim) and NEVER bare `dsh`.

first-user guided steps (no manual bridge/service/env-token paths/session IDs):
  1. install the generic-signed DEBUG/DEV APK for a fresh test install; NOT the unsigned release.
  2. install LiveVoice tgz FIRST, then Cappi tgz:
     `dsh plugin --profile web add <path>` (official CLI; explicit user install).
  3. Explicit setup consent and normal OS grants: watch Microphone; Mac Speech
     for watch ASR (Mac Microphone only for Mac input). Prebuilt universal helper
     installation needs no CLT; building exported source needs macOS SDK/CLT.
  4. pair + dual fingerprint confirm (watch wizard + Mac authenticated Settings UI):
     provisional cert derive (GET /pair/info, pinning OFF for this one call, bind
     handshake pin == response pin) -> trust confirm on BOTH -> enroll (pinned TLS,
     client CSPRNG enrollmentSecret) -> authenticated Mac approval (fingerprintConfirmed:true)
     -> poll 200 once (one-use requestId consumed; replay -> 401) -> watch SSE ->
     session select (watch Threads UI pins current thread; no typed session IDs).
  5. test: GET /watch/health -> OK, then one spoken prompt round-trip
     (mic preflight -> PCM fixture -> ASR receipt -> harness prompt draft ->
     assistant chunks -> TTS bytes).

model catalog (keyless): `sessionController.modelCatalog()` with zero routable
real providers is PASS without keys. Real-provider setup (e.g. a user API key
via the DSH Settings Models page) is an existing prerequisite outside this
tree; no credentials are invented here. Exact model id when referenced:
`meta/muse-spark-1.3-contributor`; never pass `reasoning=xhigh` (unsupported).
production ports 3083/8787/8789 are NEVER bound by this harness (ephemeral only).
EOF
}

if [ "$MODE" = "--doctor" ]; then doctor; exit 0; fi

# Scrub ambient harness variables BEFORE anything else. --------------------
for v in $(env | cut -d= -f1 | grep -E '^(DSH_|BRIDGE_|VOICE_|LIVE_VOICE_|KOKORO_|POCKET_|NPM_CONFIG_|npm_config_|XDG_)' || true); do
  unset "$v" || true
done

# Isolate BEFORE npm/Node discovery: never read user npmrc/credentials.
TDSH=$(mktemp -d "${TMPDIR:-/tmp}/vanilla-install.XXXXXX")
# Resolve only OUR trusted newly-created temp root (macOS /var -> /private/var).
# Never realpath a production state file to evade symlink refusal.
TDSH=$(CDPATH= cd -- "$TDSH" && pwd -P)
chmod 700 "$TDSH"
trap '[ "$KEEP_TMP" = 1 ] || rm -rf "$TDSH"' EXIT INT TERM
export HOME="$TDSH/hm"
export DSH_HOME="$HOME/.dsh"
export XDG_STATE_HOME="$HOME/.local/state"
export BRIDGE_STATE_DIR="$XDG_STATE_HOME/dsh-watch-bridge"
export NPM_CONFIG_USERCONFIG="$TDSH/blank-npmrc"
export NPM_CONFIG_GLOBALCONFIG=/dev/null
export NPM_CONFIG_CACHE="$TDSH/npm-cache"
export NPM_CONFIG_REGISTRY=https://registry.npmjs.org
: > "$NPM_CONFIG_USERCONFIG"
mkdir -p "$HOME" "$DSH_HOME" "$XDG_STATE_HOME" "$BRIDGE_STATE_DIR" "$NPM_CONFIG_CACHE"
chmod 700 "$HOME" "$DSH_HOME" "$BRIDGE_STATE_DIR" "$NPM_CONFIG_CACHE"
# PATH shim selects the real runtime for EVERY node call and #!/usr/bin/env
# node descendant (pnpm included), not just a version probe. Never installs
# globally or replaces the user's node executable.
if [ -n "$NODE_BIN" ]; then
  case "$NODE_BIN" in /*) ;; *) echo 'FAIL: --node-bin requires an absolute executable path' >&2; exit 1 ;; esac
  [ -x "$NODE_BIN" ] || { echo 'FAIL: --node-bin is not executable' >&2; exit 1; }
  mkdir -p "$TDSH/runtime-bin"
  ln -s "$NODE_BIN" "$TDSH/runtime-bin/node"
  export PATH="$TDSH/runtime-bin:$PATH"
fi
echo "isolated HOME=$HOME"

# Resolve the OFFICIAL DSH JS CLI entry via Node package anchors. ---------
resolve_js_entry() {
  if [ -n "$JS_ENTRY_OVERRIDE" ]; then echo "$JS_ENTRY_OVERRIDE"; return 0; fi
  if [ -n "${DSH_JS_ENTRY:-}" ]; then echo "$DSH_JS_ENTRY"; return 0; fi
  if command -v node >/dev/null 2>&1; then
    _root=$(node -e "try{console.log(require('child_process').execSync('npm root -g',{stdio:['ignore','pipe','ignore']}).toString().trim())}catch(e){}" 2>/dev/null || true)
    if [ -n "${_root:-}" ] && [ -f "$_root/@deepseek-ai/dsh/lib/bin.js" ]; then
      echo "$_root/@deepseek-ai/dsh/lib/bin.js"; return 0
    fi
  fi
  echo "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
}

JS_ENTRY=$(resolve_js_entry)
echo "js-entry: $JS_ENTRY"

fail() { echo "FAIL: $1" >&2; exit 1; }
skip() { echo "SKIP: $1"; exit 3; }

[ -f "$JS_ENTRY" ] || fail "official DSH JS entry missing: $JS_ENTRY (set --js-entry= to override)"

# Temp roots and npm isolation are established before CLI resolution.
# Temp credential files (launch token + cookie jar): created 600, never
# printed, shredded by cleanup() via $TDSH removal. Used ONLY for this
# harness's own ephemeral boot (supported login launch-token flow) — never
# read from a real user profile.
LAUNCH_TOKEN_FILE="$TDSH/launch-token"
COOKIE_JAR="$TDSH/cookies.txt"
touch "$LAUNCH_TOKEN_FILE" "$COOKIE_JAR"
chmod 600 "$LAUNCH_TOKEN_FILE" "$COOKIE_JAR" || true
# Redact helper: strip token/secret material before any log tail is shown.
redact() { sed -E 's/(\?token=)[^ "&]+/\1<redacted>/g; s/(token":")[^"]+/\1<redacted>/g; s/(enrollmentSecret":")[^"]+/\1<redacted>/g; s/(X-Bridge-Token: *)[^ ]+/\1<redacted>/gi'; }
OWN_PIDS=""
cleanup() {
  for pid in $OWN_PIDS; do
    if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
  done
  # Bounded grace, then fail-closed SIGKILL on own PIDs only (never pkill).
  sleep 2
  for pid in $OWN_PIDS; do
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi
  done
  if [ "$KEEP_TMP" = "0" ]; then rm -rf "$TDSH" "${PROBE_DIR:-/nonexistent-probe-guard}"; fi
}
trap 'cleanup' EXIT INT TERM

check_no_forbidden_port() {
  # $1 = port string; fail-closed on production ports or unparseable.
  for fp in $FORBIDDEN_PORTS; do
    if [ "$1" = "$fp" ]; then fail "bound forbidden production port $1"; fi
  done
}

# Phase 1: versions + offline composition (no boot, no keys). ---------------
echo "== phase 1: versions + offline composition =="
RUNTIME_VERSION=$(node --version) || fail "node missing (need 22.19+/24/26)"
RUNTIME_PATH=$(node -p 'process.execPath') || fail "node runtime lookup failed"
echo "actual runtime: $RUNTIME_VERSION ($RUNTIME_PATH); all CLI/install/boot descendants inherit this PATH"
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22 || (major===22 && minor<19)) process.exit(1)' || fail "runtime requires Node 22.19+"
pnpm --version || fail "pnpm missing (required by dsh plugin)"
node "$JS_ENTRY" --version || fail "dsh JS entry --version failed"
echo "expect: 0.1.2-rc.1 (record; fail on drift)"
node "$JS_ENTRY" --version 2>&1 | grep -q "0.1.2-rc.1" || fail "vanilla DSH drifted from 0.1.2-rc.1"
node "$JS_ENTRY" --profile web --dump-default-config 2>&1 | grep -E 'session-controller|workspace-controller|webserver|settings-controller' >/dev/null || fail "web composition missing session/workspace/webserver rows (refusing non-web)"
echo "PASS phase 1"

# Node22 discovery is NOT acceptance. A non-22 default run must execute
# the entire same-mode child leg AFTER its own host has stopped; only the
# child's exit 0 earns matrix PASS. --skip-node22 is runtime-only evidence.
NODE22_STATE=pending
NODE22_BIN=""
if [ "$SKIP_NODE22" = 1 ]; then
  NODE22_STATE=skipped
  echo "Node22 matrix skipped explicitly; support evidence covers actual runtime $RUNTIME_VERSION only"
else
  case "$RUNTIME_VERSION" in
    v22.*) NODE22_STATE=current ;;
    *)
      echo "== Node22 private acquisition (not a support verdict) =="
      if npm exec --yes --package=node@22 -- node -p 'process.execPath' >"$TDSH/node22-path.txt" 2>"$TDSH/node22.err"; then
        NODE22_BIN=$(tail -n 1 "$TDSH/node22-path.txt")
        if [ ! -x "$NODE22_BIN" ] || ! "$NODE22_BIN" -e 'const [m,n]=process.versions.node.split(".").map(Number); if(m!==22 || n<19) process.exit(1)'; then
          NODE22_BIN=""
        fi
      fi
      [ -n "$NODE22_BIN" ] || echo "Node22 matrix PENDING: private runtime unavailable; no FULL matrix PASS permitted"
      ;;
  esac
fi
node22_acceptance() {
  if [ "$NODE22_STATE" = skipped ]; then
    echo "MATRIX SKIPPED: native/full result applies to $RUNTIME_VERSION only"
    return 0
  fi
  if [ "$NODE22_STATE" = current ]; then
    echo "Node22 support leg PASS: full install/boot/wire executed on $RUNTIME_VERSION"
    return 0
  fi
  [ -n "$NODE22_BIN" ] || { echo 'MATRIX PENDING: Node22 full runtime unavailable'; return 3; }
  echo '== Node22 actual install/boot/wire child leg (no recursion) =='
  # Reuse the immutable private packs, never pack twice while writers build.
  set -- "$MODE" --skip-node22 "--node-bin=$NODE22_BIN" "--js-entry=$JS_ENTRY"
  [ -z "$WATCH_TGZ" ] || set -- "$@" "--watch-tgz=$WATCH_TGZ"
  [ -z "$VOICE_TGZ" ] || set -- "$@" "--voice-tgz=$VOICE_TGZ"
  [ "$REQUIRE_NATIVE" != 1 ] || set -- "$@" --require-native
  if sh "$ROOT/tools/test-vanilla-install.sh" "$@" >"$TDSH/node22-full.log" 2>&1; then
    redact < "$TDSH/node22-full.log"
    echo "MATRIX PASS: actual $RUNTIME_VERSION plus Node22 complete $MODE leg"
    return 0
  else
    _child_exit=$?
    redact < "$TDSH/node22-full.log"
    echo "Node22 full leg failed/pending (exit $_child_exit); matrix NOT PASS"
    return "$_child_exit"
  fi
}

# Phase 2: install. --probe uses a synthetic probe bundle; --full needs ----
# TWO packed tgz built from source (H watch + V voice). --------------------
PROBE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/vanilla-probe.XXXXXX")
# Private pack staging for --full (snapshot copies + built tars live here,
# never in the tree; 700). Declared early so cleanup() always covers it.
PACK_SRC="$TDSH/pack-src"
PACK_OUT="$TDSH/packs"
if [ "$MODE" = "--full" ]; then
  mkdir -p "$PACK_SRC" "$PACK_OUT"
  chmod 700 "$PACK_SRC" "$PACK_OUT" || true
fi
if [ "$MODE" = "--full" ]; then
  echo "== phase 2: pack turnkey bundles FROM SOURCE + install (full) =="
  # No-race snapshot: copy current source to a private dir (excluding
  # node_modules/build caches), verify lib/ build outputs are present and
  # stable across the copy (one retry when the UI writer is mid-build),
  # then `npm pack --ignore-scripts --offline` from the copy. Nothing is
  # written to the tree; no H/V package.json is touched.
  snapshot_plugin() {
    # $1 = plugin dir name under plugins/
    _src="$ROOT/plugins/$1"
    [ -d "$_src" ] || fail "plugin source missing: $_src"
    _dst="$PACK_SRC/$1"
    rm -rf "$_dst"
    python3 "$ROOT/tools/lib/snapshot-plugin.py" "$_src" "$_dst" || fail "$1 changed during source/build stable gate; do not pack in-flight builds"
    echo "snapshot ok: $1 ($(du -sk "$_dst" | cut -f1) KB, lib present)"
  }
  pack_plugin() {
    # $1 = plugin dir name; prints the resulting tgz path (newest tar in
    # PACK_OUT after packing — PACK_OUT gains exactly one tar per call).
    _dst="$PACK_SRC/$1"
    (cd "$_dst" && npm pack --ignore-scripts --offline --pack-destination "$PACK_OUT" >"$TDSH/pack-$1.out" 2>"$TDSH/pack-$1.log") || {
      tail -n 5 "$TDSH/pack-$1.log" >&2; fail "npm pack failed: $1"
    }
    ls -t "$PACK_OUT"/*.tgz | head -n 1
  }
  if [ -n "$WATCH_TGZ" ] && [ -n "$VOICE_TGZ" ]; then
    echo "using parent-supplied tars (override): $WATCH_TGZ $VOICE_TGZ"
    [ -f "$WATCH_TGZ" ] || fail "watch tgz missing: $WATCH_TGZ"
    [ -f "$VOICE_TGZ" ] || fail "voice tgz missing: $VOICE_TGZ"
  else
    snapshot_plugin "dsh-watch"
    snapshot_plugin "dsh-live-voice"
    WATCH_TGZ=$(pack_plugin "dsh-watch")
    VOICE_TGZ=$(pack_plugin "dsh-live-voice")
    [ -n "$WATCH_TGZ" ] && [ -f "$WATCH_TGZ" ] || fail "watch tar not produced"
    [ -n "$VOICE_TGZ" ] && [ -f "$VOICE_TGZ" ] || fail "voice tar not produced"
    [ "$WATCH_TGZ" != "$VOICE_TGZ" ] || fail "pack collision: watch and voice tars identical"
    echo "packed: $WATCH_TGZ"
    echo "packed: $VOICE_TGZ"
  fi
  node "$JS_ENTRY" plugin --profile web add "$VOICE_TGZ" || fail "voice tgz install exit != 0"
  node "$JS_ENTRY" plugin --profile web add "$WATCH_TGZ" || fail "watch tgz install exit != 0"
  node "$JS_ENTRY" --profile web --dump-config 2>&1 | grep -E 'turnkey|watch-bridge|live-voice|liveVoiceWatch' >/dev/null || {
    echo "SKIP: turnkey rows absent after install (H/V composition unfinished?)"
    exit 3
  }
  # Manifest reconciliation: profile bundles must list BOTH installed
  # packages (exact install proof, not just exit 0).
  grep -q 'dsh-watch' "$DSH_HOME/profiles/web/package.json" || fail "watch bundle absent from profile bundles after install"
  grep -q 'dsh-live-voice' "$DSH_HOME/profiles/web/package.json" || fail "voice bundle absent from profile bundles after install"
  node "$JS_ENTRY" --profile web --dump-config 2>&1 | grep -q -- '- id: watch' || fail "dump-config lacks watch row after install"
  node "$JS_ENTRY" --profile web --dump-config 2>&1 | grep -q 'live-voice' || fail "dump-config lacks live-voice row after install"
  # Tar-member truth in two tiers. REQUIRED members (built lib outputs,
  # patch file, manifests) fail closed when absent. NATIVE-READINESS members
  # (helper sources, build script, compiled binary) are RECORDED, not
  # failed: V's stated intent is to ship them via `resources`/scripts, but
  # the npm `files` whitelist + nested .gitignore currently drop the binary
  # and the build script — those gaps are V packaging next-fixes (PA does
  # not edit V manifests), detected here not assumed.
  python3 - "$WATCH_TGZ" "$VOICE_TGZ" >"$TDSH/tarcheck.txt" 2>&1 <<'EOF' || { cat "$TDSH/tarcheck.txt" >&2; fail "tar member check failed (see above)"; }
import sys, tarfile
def members(tgz):
    with tarfile.open(tgz, "r:gz") as tf:
        return set(tf.getnames())
w = members(sys.argv[1])
for m in ("package/lib/index.js", "package/lib/client.js",
          "package/cordis.patch.yml", "package/package.json"):
    assert m in w, "watch tar missing REQUIRED " + m
print("watch tar REQUIRED members ok (%d files)" % len(w))
v = members(sys.argv[2])
for m in ("package/lib/index.js", "package/lib/watch-api.js",
          "package/cordis.patch.yml", "package/package.json"):
    assert m in v, "voice tar missing REQUIRED " + m
print("voice tar REQUIRED members ok (%d files)" % len(v))
native = ("package/resources/watch-asr.swift",
          "package/resources/watch-asr-Info.plist",
          "package/resources/watch-asr.manifest.json",
          "package/scripts/build-watch-helpers.sh",
          "package/resources/bin/watch-asr")
for m in native:
    print("NATIVE-MEMBER %s %s" % ("present" if m in v else "ABSENT", m))
EOF
  cat "$TDSH/tarcheck.txt"
  # Flags for phase 9 (BLOCKED, not FAIL, when V staging drops them).
  HELPER_SHIPPED=0; SCRIPT_SHIPPED=0
  if grep -q "NATIVE-MEMBER present package/resources/bin/watch-asr" "$TDSH/tarcheck.txt"; then HELPER_SHIPPED=1; fi
  if grep -q "NATIVE-MEMBER present package/scripts/build-watch-helpers.sh" "$TDSH/tarcheck.txt"; then SCRIPT_SHIPPED=1; fi
  [ "$HELPER_SHIPPED" = "1" ] || echo "note: voice tar lacks resources/bin/watch-asr (V packaging next-fix; see phase 9)"
  [ "$SCRIPT_SHIPPED" = "1" ] || echo "note: voice tar lacks scripts/build-watch-helpers.sh (V packaging next-fix; see phase 9)"
  # Fixture LLM plugin (private temp ONLY, never the tree, never shipped):
  # a deterministic local adapter via the OFFICIAL ctx.llm.registerAdapter
  # plus real sessionController list/create/prompt/page/follow behind one
  # authed debug route. No external keys, no API gateway, no network
  # provider. Phrase/ids are synthetic TEST-FIXTURE constants (public-safe).
  echo "-- fixture LLM plugin (temp-only, official registerAdapter) --"
  FIXTURE_DIR="$TDSH/fixture-llm"
  mkdir -p "$FIXTURE_DIR/lib"
  chmod 700 "$FIXTURE_DIR" || true
  cat > "$FIXTURE_DIR/package.json" <<'EOF'
{"name":"turnkey-fixture-llm","version":"0.0.0","type":"module","main":"lib/index.js","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}
EOF
  cat > "$FIXTURE_DIR/cordis.patch.yml" <<'EOF'
- insert:
    - id: fixture-llm
      name: turnkey-fixture-llm
      config: {}
EOF
  cat > "$FIXTURE_DIR/lib/index.js" <<'EOF'
// turnkey-fixture-llm (TEST-ONLY routing fixture; harness-built in temp,
// never shipped, never a package fallback). Deterministic local adapter
// via the official ctx.llm.registerAdapter + real sessionController
// list/create/selectModel/prompt/page/follow. Exact rc1 DTOs only:
// prompt carries requestId + sessionId + mode + content parts with a
// caller-owned AbortSignal; short object forms are never used anywhere.
export const name = 'fixture-llm';
export const inject = ['llm', 'sessionController', 'webServer', 'connection', 'tools', 'liveVoiceWatch', 'approval'];
const PROVIDER = 'fixture-local';
const MODEL = 'fixture-echo-1';
const PHRASE = 'TEST-FIXTURE turnkey routing check alpha';
const ECHO = 'route-ok TEST-FIXTURE turnkey routing check alpha';
let proof = null;
let nextTool = null;
let callbackProof = null;
const adapter = {
  providerInfo(provider) {
    return { id: provider, name: 'Fixture Local (TEST-ONLY routing)' };
  },
  providerRetryPolicy(_provider) {
    return undefined;
  },
  async listModels(provider) {
    return [{ provider, id: MODEL, name: 'Fixture Echo 1' }];
  },
  async resolveModel(provider, model, _signal) {
    return { provider, id: model, name: 'Fixture Echo 1', context: { contextWindow: 4096 } };
  },
  async prepareCall(provider, model, signal) {
    const meta = await adapter.resolveModel(provider, model, signal);
    return { model: meta, stream: (options) => adapter.stream(options) };
  },
  async *stream(_options) {
    if (nextTool) {
      const tool = nextTool; nextTool = null;
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: tool.id, name: tool.name, argumentsDelta: tool.arguments };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', ...tool } };
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    const reply = proof && proof.finals.length ? proof.expectedEcho : ECHO;
    yield { type: 'text-delta', index: 0, text: reply };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  },
};
function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
export async function apply(ctx, _config) {
  const credentialEnvKeys = Object.keys(process.env).filter(key => /^(OPENAI_|ANTHROPIC_|DEEPSEEK_|OPENROUTER_|GEMINI_|GOOGLE_|XAI_|MISTRAL_|GROQ_|FAL_|ELEVENLABS_|MINIMAX_|ASSEMBLYAI_|CARTESIA_|AWS_|AZURE_|HF_|HUGGING_FACE_|GIT_CONFIG_)/.test(key) || /_(API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/.test(key) || ['SSH_AUTH_SOCK', 'GIT_ASKPASS'].includes(key));
  if (credentialEnvKeys.length) throw new Error('credential environment keynames survived strict isolation');
  ctx.llm.registerAdapter([PROVIDER], adapter);
  // Official registry-ready ToolDefinition with JSON Schema; no bare peer
  // import from this linked temp fixture directory (no local node_modules).
  ctx.tools.register({
    name: 'fixture_approval', description: 'TEST-ONLY harmless approval callback; never shipped',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', properties: { outcome: { type: 'string' } }, required: ['outcome'], additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      return { outcome: await ctx.approval.request({ agent: exec.agent, toolName: 'fixture_approval', callId: exec.callId,
        reason: 'TEST-FIXTURE harmless callback, no external action', signal: exec.signal }) };
    },
  });
  // Passive test-only observation: delegate to the unchanged production
  // backend; never fabricate finals, ACKs, PCM, or synthesis completions.
  const svc = ctx.liveVoiceWatch;
  const originalInput = svc.createInput.bind(svc);
  const originalSynth = svc.synthesize.bind(svc);
  svc.createInput = (args) => originalInput({ ...args, onEvent: async (event) => {
    if (proof && event.kind === 'final') proof.finals.push({ ...event });
    if (proof && event.kind === 'error') proof.errors.push({ ...event });
    return args.onEvent(event);
  } });
  svc.synthesize = (args) => {
    if (proof) proof.syntheses.push({ speechId: args.speechId, text: args.text });
    return originalSynth(args);
  };
  ctx.effect(() => () => { svc.createInput = originalInput; svc.synthesize = originalSynth; });
  let fixtureSession = '';
  async function snapshot(sessionId, signal) {
    const stream = ctx.sessionController.follow({ address: { kind: 'session', sessionId } }, signal);
    for await (const frame of stream) {
      if (frame.type === 'snapshot') return frame;
      throw new Error('SDK follow must open with snapshot');
    }
    throw new Error('SDK follow returned no snapshot');
  }
  for (const route of ['__native__', '__cappi__', '__callback__']) ctx.webServer.register({
    kind: 'exact', path: '/fixture-llm/' + route,
    handler: (req, res) => { void (async () => {
      const rej = ctx.connection.requestRejection({ headers: req.headers || {} });
      if (rej === 401 || rej === 403) return sendJson(res, rej, { ok: false });
      if (req.method !== 'GET' || !fixtureSession) return sendJson(res, 409, { ok: false });
      const signal = AbortSignal.timeout(15000);
      if (route === '__cappi__') {
        const resolved = await ctx.sessionController.resolveAgent(fixtureSession);
        if (!resolved.agent || String(resolved.agent.id) !== fixtureSession) throw new Error('real SDK agent binding missing');
        const { randomUUID } = await import('node:crypto');
        const result = await ctx.tools.execute({ callId: randomUUID(), name: 'cappi_action', arguments: { action: 'dance' }, agent: resolved.agent, signal });
        if (result.isError || result.value?.ok !== true) throw new Error('registered Cappi tool execution refused');
        return sendJson(res, 200, { ok: true, action: result.value.action, agentBound: true });
      }
      const phase = new URL(req.url, 'http://127.0.0.1').searchParams.get('phase');
      const current = await snapshot(fixtureSession, signal);
      if (route === '__callback__') {
        if (phase === 'proof') {
          if (!callbackProof) throw new Error('callback not armed');
          return sendJson(res, 200, { ok: true, ...callbackProof, snapshot: current });
        }
        if (phase !== 'approval' && phase !== 'question') throw new Error('invalid callback phase');
        const { randomUUID } = await import('node:crypto');
        const resolved = await ctx.sessionController.resolveAgent(fixtureSession);
        if (!resolved.agent) throw new Error('fixture agent absent');
        // Scope only our synthetic Agent; no user/profile approval policy change.
        ctx.approval.setPolicy(resolved.agent, 'ask');
        const id = randomUUID();
        callbackProof = { baselineCursor: current.cursor, callId: id, kind: phase };
        nextTool = { id, name: phase === 'approval' ? 'fixture_approval' : 'ask_user_question', arguments: phase === 'approval' ? '{}' :
          JSON.stringify({ questions: [{ id: 'fixture-choice', question: 'TEST-FIXTURE choose the synthetic answer', options: [{ label: 'fixture-answer' }] }] }) };
        const prompted = await ctx.sessionController.prompt({ requestId: randomUUID(), sessionId: fixtureSession, mode: 'queue', content: [{ type: 'text', text: 'TEST-FIXTURE callback ' + phase }] }, signal);
        return sendJson(res, 200, { ok: true, accepted: prompted.accepted, kind: phase });
      }
      if (phase === 'arm') {
        const { randomUUID } = await import('node:crypto');
        proof = { baselineCursor: current.cursor, finals: [], errors: [], syntheses: [], expectedEcho: 'native-route-ok TEST-FIXTURE ' + randomUUID() };
        return sendJson(res, 200, { ok: true, baselineCursor: proof.baselineCursor });
      }
      if (!proof) throw new Error('native proof not armed');
      return sendJson(res, 200, { ok: true, ...proof, snapshot: current });
    })().catch(() => sendJson(res, 500, { ok: false, error: 'fixture-observation-failed' })); },
  });
  ctx.webServer.register({
    kind: 'exact',
    path: '/fixture-llm/__run__',
    handler: (req, res) => {
      void runRoute(req, res).catch((e) => {
        try {
          sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
        } catch (_ignored) { /* closing */ }
      });
    },
  });
  ctx.effect(() => () => {}, 'fixture-llm: TEST-ONLY routing adapter');
  async function runRoute(req, res) {
    const rej = ctx.connection.requestRejection({ headers: req.headers || {} });
    if (rej === 401 || rej === 403) {
      sendJson(res, rej, { ok: false, error: rej === 401 ? 'unauthorized' : 'forbidden' });
      return;
    }
    if ((req.method || 'GET') !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error('fixture-timeout')), 120000);
    if (timer.unref) timer.unref();
    try {
      const sc = ctx.sessionController;
      const catalog = await sc.modelCatalog();
      const routable = Array.isArray(catalog.routableProviders) ? catalog.routableProviders : [];
      const created = await sc.create({});
      const sessionId = String(created.sessionId);
      fixtureSession = sessionId;
      await sc.selectModel({ sessionId, provider: PROVIDER, model: MODEL });
      const { randomUUID } = await import('node:crypto');
      await sc.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: PHRASE }],
      }, ctl.signal);
      // Follow the durable log until BOTH the user record (PHRASE) and the
      // adapter echo (ECHO) appear, or the bounded wait expires. Frames are
      // matched by substring over the real records (no invented DTO keys).
      let userFound = false;
      let assistantFound = false;
      let frames = 0;
      const deadline = Date.now() + 90000;
      const stream = sc.follow({ address: { kind: 'session', sessionId } }, ctl.signal);
      try {
        for await (const frame of stream) {
          frames += 1;
          let blob = '';
          try {
            blob = JSON.stringify(frame);
          } catch (_ignored) { blob = ''; }
          if (blob.indexOf(PHRASE) !== -1) userFound = true;
          if (blob.indexOf(ECHO) !== -1) assistantFound = true;
          if (userFound && assistantFound) break;
          if (Date.now() > deadline) break;
        }
      } finally {
        try {
          ctl.abort(new Error('fixture-done'));
        } catch (_ignored) { /* done */ }
      }
      sendJson(res, 200, {
        ok: true,
        sessionId,
        routableIncludesFixture: routable.indexOf(PROVIDER) !== -1,
        credentialEnvKeys,
        routable,
        userFound,
        assistantFound,
        frames,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
EOF
  node --check "$FIXTURE_DIR/lib/index.js" || fail "fixture plugin syntax check failed"
  grep -q 'registerAdapter' "$FIXTURE_DIR/lib/index.js" || fail "fixture plugin lacks official registerAdapter"
  grep -q "content: \[{ type: 'text', text: PHRASE }\]" "$FIXTURE_DIR/lib/index.js" || fail "fixture plugin lacks exact content-parts prompt DTO"
  node "$JS_ENTRY" plugin --profile web add "$FIXTURE_DIR" || fail "fixture plugin install exit != 0"
  grep -q 'turnkey-fixture-llm' "$DSH_HOME/profiles/web/package.json" || fail "fixture bundle absent from profile bundles after install"
  echo "fixture LLM plugin installed (temp-only; phrase/model synthetic)"
  echo "PASS phase 2 (turnkey bundles packed from source + installed + reconciled)"
else
  echo "== phase 2: install synthetic probe bundle (probe) =="
  mkdir -p "$PROBE_DIR/probe-pkg"
  cat > "$PROBE_DIR/probe-pkg/package.json" <<'EOF'
{"name":"turnkey-probe","version":"0.0.0","type":"module","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}
EOF
  cat > "$PROBE_DIR/probe-pkg/cordis.patch.yml" <<'EOF'
[]
EOF
  mkdir -p "$PROBE_DIR/probe-pkg/lib"
  echo "export const probe = true;" > "$PROBE_DIR/probe-pkg/lib/index.js"
  node "$JS_ENTRY" plugin --profile web add "$PROBE_DIR/probe-pkg" || fail "probe install exit != 0"
  grep -q 'turnkey-probe' "$DSH_HOME/profiles/web/package.json" || fail "probe bundle absent from profile bundles after install"
  echo "PASS phase 2 (probe installed; ONLY supported path: dsh plugin --profile web add)"
fi

# Official CLI TEST-ONLY overlay: own ephemeral UDP, and disable the default
# external DeepSeek adapter so no real provider is routable during keyless
# fixtures. SDK route registration alone does not mean credentials exist.
# No source/default-config/token/session changes. Probe uses an empty overlay.
ISOLATION_PATCH="$TDSH/network-isolation.patch.yml"
if [ "$MODE" = '--full' ]; then
  DISCOVERY_PORT=$(python3 - <<'EOF'
import socket
while True:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    if 10000 < port < 65520: print(port); break
EOF
  )
  printf -- '- id: watch\n  config:\n    discoveryPort: %s\n- id: llm-deepseek\n  disabled: true\n' "$DISCOVERY_PORT" > "$ISOLATION_PATCH"
else
  printf '[]\n' > "$ISOLATION_PATCH"
fi
# Phase 3: keyless ephemeral boot (no credentials, ephemeral ports). -------
echo "== phase 3: keyless ephemeral boot =="
BOOT_LOG="$TDSH/boot.log"
PORT_FILE="$TDSH/port.txt"
# SDK workspace is ALSO empty/owned: never auto-read the release/original
# repository's git config, agent notes, projects or environment dotfiles.
mkdir -p "$TDSH/empty-workspace"
# Boot web on an OS-assigned port; --no-open never opens a browser.
(CDPATH= cd -- "$TDSH/empty-workspace" && exec node "$JS_ENTRY" --profile web --patch "$ISOLATION_PATCH" -- --port 0 --no-open) >"$BOOT_LOG" 2>&1 &
BOOT_PID=$!
OWN_PIDS="$OWN_PIDS $BOOT_PID"
# Wait for the ephemeral URL line (bounded 45s); never accept fixed defaults.
BOUND_URL=""
for _i in $(seq 1 45); do
  sleep 1
  if ! kill -0 "$BOOT_PID" 2>/dev/null; then fail "web boot exited early (see $BOOT_LOG)"; fi
  BOUND_URL=$(grep -Eo 'http://127\.0\.0\.1:[0-9]+/' "$BOOT_LOG" | head -n 1 || true)
  if [ -n "$BOUND_URL" ]; then break; fi
done
[ -n "$BOUND_URL" ] || fail "no ephemeral web URL in boot log"
BOUND_PORT=$(printf '%s' "$BOUND_URL" | sed -E 's#.*:([0-9]+)/#\1#')
echo "bound: $BOUND_URL (port $BOUND_PORT)"
echo "$BOUND_PORT" > "$PORT_FILE"
check_no_forbidden_port "$BOUND_PORT"
# Keyless gates: unauthenticated / and /api/ must be 401.
code_root=$(curl -s -o /dev/null -w '%{http_code}' "$BOUND_URL" 2>/dev/null || echo "000")
echo "GET / -> $code_root"
[ "$code_root" = "401" ] || fail "keyless gate not 401 on / (got $code_root)"
code_api=$(curl -s -o /dev/null -w '%{http_code}' "${BOUND_URL}api/" 2>/dev/null || echo "000")
echo "GET /api/ -> $code_api"
[ "$code_api" = "401" ] || fail "keyless gate not 401 on /api/ (got $code_api)"
# Temp home gained only skeletal state (no user keys created or read).
ls "$HOME/.dsh" >/dev/null 2>&1 || fail "temp DSH_HOME missing after boot"
# Capture OUR OWN launch token to a 600 file (never printed): the supported
# browser login is GET /?token=<launch-token> -> 303 + HttpOnly cookie.
# This token comes from OUR temp boot log only — never a user profile.
grep -Eo '\?token=[^ ]+' "$BOOT_LOG" | head -n 1 | sed 's/?token=//' > "$LAUNCH_TOKEN_FILE" || true
chmod 600 "$LAUNCH_TOKEN_FILE" || true
[ -s "$LAUNCH_TOKEN_FILE" ] || fail "own launch token missing from boot log"
echo "PASS phase 3 (ephemeral keyless boot; 401 gates hold; own launch token captured privately)"

# --probe stops here with PASS (probe-only). --full continues below.
if [ "$MODE" = "--probe" ]; then
  kill "$BOOT_PID" 2>/dev/null || true
  wait "$BOOT_PID" 2>/dev/null || true
  node22_acceptance || exit $?
  echo "=============================="
  echo "PROBE PASS (keyless vanilla install+boot verified)"
  echo "FULL SKIPPED (run --full for the turnkey pairing/voice legs)."
  exit 0
fi

echo "== phase 4: browser login via OWN launch token (full only) =="
# Supported login: GET /?token=<own-launch-token> -> 303 + HttpOnly cookie.
# The token file is 600 and is NEVER printed (redact() guards any echo).
LOGIN_CODE=$(curl -s -c "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "${BOUND_URL}?token=$(cat "$LAUNCH_TOKEN_FILE")") || fail "login request failed"
[ "$LOGIN_CODE" = "303" ] || fail "login via own launch token: want 303, got $LOGIN_CODE"
chmod 600 "$COOKIE_JAR" || true
grep -q 'dsh-auth' "$COOKIE_JAR" || fail "login cookie missing from jar"
code_home_auth=$(curl -s -b "$COOKIE_JAR" -o /dev/null -w '%{http_code}' "$BOUND_URL") || fail "authed GET / failed"
[ "$code_home_auth" = "200" ] || fail "authed GET /: want 200, got $code_home_auth"
echo "PASS phase 4 (own-token login 303 -> cookie; authed GET / 200)"

echo "== phase 5: admin pairing surface gates (full only) =="
ADMIN_URL="${BOUND_URL}admin/pair/status"
code_admin_noauth=$(curl -s -o /dev/null -w '%{http_code}' "$ADMIN_URL") || fail "unauthed admin probe failed"
[ "$code_admin_noauth" = "401" ] || fail "admin unauth: want 401, got $code_admin_noauth"
code_admin_foreign=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BOUND_URL}admin/pair/approval" -H 'Content-Type: application/json' -H 'Origin: http://evil.invalid' --data '{"requestId":"x"}') || fail "foreign-origin probe failed"
case "$code_admin_foreign" in
  401|403) echo "foreign Origin rejected ($code_admin_foreign)" ;;
  *) fail "foreign Origin: want 401/403, got $code_admin_foreign" ;;
esac
ADMIN_JSON="$TDSH/admin-status.json"
code_admin_auth=$(curl -s -b "$COOKIE_JAR" -o "$ADMIN_JSON" -w '%{http_code}' "$ADMIN_URL") || fail "authed admin status failed"
[ "$code_admin_auth" = "200" ] || { redact < "$ADMIN_JSON" | head -c 300 >&2; echo >&2; fail "authed admin status: want 200, got $code_admin_auth"; }
python3 - "$ADMIN_JSON" <<'EOF' || fail "admin status shape wrong (see above)"
import json, sys
d = json.load(open(sys.argv[1]))
assert isinstance(d.get("fingerprint"), dict) and d["fingerprint"].get("full") and d["fingerprint"].get("short"), "fingerprint"
assert isinstance(d.get("port"), int) and d["port"] > 0, "port"
assert isinstance(d.get("hostCandidates"), list), "hostCandidates"
assert "backendStatus" in d, "backendStatus"
assert isinstance(d.get("pending"), list) and isinstance(d.get("devices"), list), "pending/devices"
print("admin status shape ok: port=%d backend=%s" % (d["port"], d["backendStatus"]))
EOF
LAN_PORT=$(python3 -c "import json;print(json.load(open('$ADMIN_JSON'))['port'])")
check_no_forbidden_port "$LAN_PORT"
LAN_BASE="https://127.0.0.1:$LAN_PORT"
TURNKEY_CERT="$DSH_HOME/profiles/web/dsh-watch/turnkey/cert.pem"
[ -f "$TURNKEY_CERT" ] || fail "H turnkey cert missing: $TURNKEY_CERT"
echo "PASS phase 5 (admin 401 unauth, foreign-Origin reject, authed status shape ok; LAN port $LAN_PORT)"

echo "== phase 6: provisional-cert pairing + dual-confirm enroll (full only) =="
INFO_JSON="$TDSH/pair-info.json"
code_info=$(curl -sk -o "$INFO_JSON" -w '%{http_code}' "$LAN_BASE/pair/info") || fail "GET /pair/info failed"
[ "$code_info" = "200" ] || fail "GET /pair/info: want 200, got $code_info"
python3 - "$INFO_JSON" <<'EOF' || fail "pair/info shape wrong (see above)"
import json, re, sys
d = json.load(open(sys.argv[1]))
assert d.get("pairProtocol") == "turnkey/1", "pairProtocol"
assert re.fullmatch(r"sha256/[A-Za-z0-9+/=]{43,44}", d.get("certSha256Pin", "")), "certSha256Pin"
assert isinstance(d.get("nonce"), str) and len(d["nonce"]) >= 8, "nonce"
fp = d.get("fingerprint", {})
assert re.fullmatch(r"(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}", fp.get("full", "")), "fingerprint.full"
assert len(fp.get("short", "")) >= 8, "fingerprint.short"
print("pair/info shape ok")
EOF
# Bind-assert: derive the pin from the ACTUAL TLS handshake cert (never
# trust the JSON body alone) and require byte-equality with the response.
DERIVED_PIN="sha256/$(openssl s_client -connect "127.0.0.1:$LAN_PORT" -servername 127.0.0.1 </dev/null 2>/dev/null | openssl x509 -outform DER 2>/dev/null | openssl dgst -sha256 -binary 2>/dev/null | openssl base64 2>/dev/null)"
BODY_PIN=$(python3 -c "import json;print(json.load(open('$INFO_JSON'))['certSha256Pin'])")
[ -n "$DERIVED_PIN" ] && [ "$DERIVED_PIN" != "sha256/" ] || fail "TLS cert pin derivation failed"
[ "$DERIVED_PIN" = "$BODY_PIN" ] || fail "bind-assert mismatch: handshake pin != response pin (trust-mismatch)"
echo "bind-assert ok (handshake cert pin == response pin; pin value never printed)"
# Enroll WITHOUT confirmation must fail closed (403 approval-required).
code_enroll_bare=$(curl -s --cacert "$TURNKEY_CERT" -o /dev/null -w '%{http_code}' "$LAN_BASE/pair/enroll" -H 'Content-Type: application/json' --data '{"deviceAlias":"harness-watch"}') || fail "bare enroll probe failed"
[ "$code_enroll_bare" = "403" ] || fail "bare enroll: want 403, got $code_enroll_bare"
# Deny path before approval: provisional enroll -> admin deny (no secrets in deny body) -> poll non-200.
ENROLL2_SECRET_FILE="$TDSH/enroll2-secret"
python3 -c "import secrets;print(secrets.token_urlsafe(24))" > "$ENROLL2_SECRET_FILE"
chmod 600 "$ENROLL2_SECRET_FILE" || true
ENROLL2_JSON="$TDSH/enroll2.json"
ENROLL2_BODY="$TDSH/enroll2-body.json"
python3 - "$ENROLL2_BODY" "$ENROLL2_SECRET_FILE" <<'EOF' || fail "enroll2 body build failed"
import json, sys
json.dump({"deviceAlias": "harness-watch-2", "fingerprintConfirmed": True,
           "enrollmentSecret": open(sys.argv[2]).read().strip()},
          open(sys.argv[1], "w"))
EOF
chmod 600 "$ENROLL2_BODY" || true
code_enroll2=$(curl -s --cacert "$TURNKEY_CERT" -o "$ENROLL2_JSON" -w '%{http_code}' "$LAN_BASE/pair/enroll" -H 'Content-Type: application/json' -H 'X-Fingerprint-Confirmed: true' --data @"$ENROLL2_BODY") || fail "second enroll failed"
[ "$code_enroll2" = "201" ] || fail "second enroll: want 201, got $code_enroll2"
REQ_ID2=$(python3 -c "import json;print(json.load(open('$ENROLL2_JSON'))['requestId'])")
DENY_JSON="$TDSH/deny.json"
DENY_BODY="$TDSH/deny-body.json"
python3 - "$DENY_BODY" "$REQ_ID2" <<'EOF' || fail "deny body build failed"
import json, sys
json.dump({"requestId": sys.argv[2], "approve": False,
           "fingerprintConfirmed": True}, open(sys.argv[1], "w"))
EOF
code_deny=$(curl -s -b "$COOKIE_JAR" -o "$DENY_JSON" -w '%{http_code}' "${BOUND_URL}admin/pair/approval" -H 'Content-Type: application/json' --data @"$DENY_BODY") || fail "admin deny failed"
[ "$code_deny" = "200" ] || fail "admin deny: want 200, got $code_deny"
POLL2_BODY="$TDSH/poll2-body.json"
python3 - "$POLL2_BODY" "$REQ_ID2" "$ENROLL2_SECRET_FILE" <<'EOF' || fail "poll2 body build failed"
import json, sys
json.dump({"requestId": sys.argv[2],
           "enrollmentSecret": open(sys.argv[3]).read().strip()},
          open(sys.argv[1], "w"))
EOF
chmod 600 "$POLL2_BODY" || true
code_poll_denied=$(curl -s --cacert "$TURNKEY_CERT" -o /dev/null -w '%{http_code}' "$LAN_BASE/pair/poll" -H 'Content-Type: application/json' --data @"$POLL2_BODY") || fail "denied poll failed"
case "$code_poll_denied" in
  401|410) echo "denied poll correctly non-200 ($code_poll_denied)" ;;
  *) fail "denied poll: want 401/410, got $code_poll_denied" ;;
esac
echo "PASS phase 6b (deny path: enroll 201 -> deny 200 -> poll $code_poll_denied)"


# Dual-confirm enroll: CSPRNG secret (600 file) + explicit confirmation.
ENROLL_SECRET_FILE="$TDSH/enroll-secret"
python3 -c "import secrets;print(secrets.token_urlsafe(24))" > "$ENROLL_SECRET_FILE"
chmod 600 "$ENROLL_SECRET_FILE" || true
ENROLL_JSON="$TDSH/enroll.json"
ENROLL_BODY="$TDSH/enroll-body.json"
python3 - "$ENROLL_BODY" "$ENROLL_SECRET_FILE" <<'EOF' || fail "enroll body build failed"
import json, sys
json.dump({"deviceAlias": "harness-watch", "deviceKind": "Wear OS",
           "model": "harness-fixture", "fingerprintConfirmed": True,
           "enrollmentSecret": open(sys.argv[2]).read().strip()},
          open(sys.argv[1], "w"))
EOF
chmod 600 "$ENROLL_BODY" || true
code_enroll=$(curl -s --cacert "$TURNKEY_CERT" -o "$ENROLL_JSON" -w '%{http_code}' "$LAN_BASE/pair/enroll" -H 'Content-Type: application/json' -H 'X-Fingerprint-Confirmed: true' --data @"$ENROLL_BODY") || fail "confirm enroll failed"
[ "$code_enroll" = "201" ] || { redact < "$ENROLL_JSON" | head -c 300 >&2; echo >&2; fail "confirm enroll: want 201, got $code_enroll"; }
REQ_ID=$(python3 -c "import json;print(json.load(open('$ENROLL_JSON'))['requestId'])")
[ -n "$REQ_ID" ] || fail "enroll 201 without requestId"
echo "enroll ok (201; requestId recorded privately)"
# Poll while pending -> 202 (never 200 before Mac approval).
POLL_JSON="$TDSH/poll-pending.json"
POLL_BODY="$TDSH/poll-body.json"
python3 - "$POLL_BODY" "$REQ_ID" "$ENROLL_SECRET_FILE" <<'EOF' || fail "poll body build failed"
import json, sys
json.dump({"requestId": sys.argv[2],
           "enrollmentSecret": open(sys.argv[3]).read().strip()},
          open(sys.argv[1], "w"))
EOF
chmod 600 "$POLL_BODY" || true
code_poll_pending=$(curl -s --cacert "$TURNKEY_CERT" -o "$POLL_JSON" -w '%{http_code}' "$LAN_BASE/pair/poll" -H 'Content-Type: application/json' --data @"$POLL_BODY") || fail "pending poll failed"
[ "$code_poll_pending" = "202" ] || fail "pending poll: want 202, got $code_poll_pending"
# Authenticated Mac approval (fingerprintConfirmed:true REQUIRED).
APPROVE_JSON="$TDSH/approve.json"
APPROVE_BODY="$TDSH/approve-body.json"
python3 - "$APPROVE_BODY" "$REQ_ID" <<'EOF' || fail "approval body build failed"
import json, sys
json.dump({"requestId": sys.argv[2], "approve": True,
           "fingerprintConfirmed": True}, open(sys.argv[1], "w"))
EOF
code_approve=$(curl -s -b "$COOKIE_JAR" -o "$APPROVE_JSON" -w '%{http_code}' "${BOUND_URL}admin/pair/approval" -H 'Content-Type: application/json' --data @"$APPROVE_BODY") || fail "admin approval failed"
[ "$code_approve" = "200" ] || { redact < "$APPROVE_JSON" | head -c 300 >&2; echo >&2; fail "admin approval: want 200, got $code_approve"; }
# Poll after approval -> 200 EXACTLY ONCE (deviceId + token + pin re-check).
POLL_JSON2="$TDSH/poll-approved.json"
code_poll=$(curl -s --cacert "$TURNKEY_CERT" -o "$POLL_JSON2" -w '%{http_code}' "$LAN_BASE/pair/poll" -H 'Content-Type: application/json' --data @"$POLL_BODY") || fail "approved poll failed"
[ "$code_poll" = "200" ] || fail "approved poll: want 200, got $code_poll"
python3 - "$POLL_JSON2" <<'EOF' || fail "approved poll shape wrong (see above)"
import json, re, sys
d = json.load(open(sys.argv[1]))
assert d.get("status") == "approved", "status"
assert isinstance(d.get("deviceId"), str) and d["deviceId"], "deviceId"
assert isinstance(d.get("token"), str) and len(d["token"]) >= 22, "token"
assert re.fullmatch(r"sha256/[A-Za-z0-9+/=]{43,44}", d.get("certSha256Pin", "")), "pin"
print("approved poll shape ok")
EOF
POLL_PIN=$(python3 -c "import json;print(json.load(open('$POLL_JSON2'))['certSha256Pin'])")
[ "$POLL_PIN" = "$DERIVED_PIN" ] || fail "poll pin != handshake pin"
DEVICE_ID=$(python3 -c "import json;print(json.load(open('$POLL_JSON2'))['deviceId'])")
DEVICE_TOKEN_FILE="$TDSH/device-token"
python3 -c "import json;print(json.load(open('$POLL_JSON2'))['token'])" > "$DEVICE_TOKEN_FILE"
chmod 600 "$DEVICE_TOKEN_FILE" || true
# Replay the same poll -> must REJECT (contract: 401 approval-replay for a
# consumed one-use requestId; current H build answers 410 approval-expired
# because it deletes the row on consume — rejection holds, code label
# drifts; recorded as H next-fix, never a second token issuance).
REPLAY_JSON="$TDSH/poll-replay.json"
code_replay=$(curl -s --cacert "$TURNKEY_CERT" -o "$REPLAY_JSON" -w '%{http_code}' "$LAN_BASE/pair/poll" -H 'Content-Type: application/json' --data @"$POLL_BODY") || fail "replay poll failed"
case "$code_replay" in
  401) echo "replay correctly 401 (contract-exact)" ;;
  410)
    echo "note: replay 410 (H row deleted on consume; contract wants 401 approval-replay) — rejection holds, no second issuance; logged as H next-fix"
    REPLAY_DRIFT=1
    ;;
  *) fail "replay poll: want 401 (410 tolerated as H drift, see note), got $code_replay" ;;
esac
python3 - "$REPLAY_JSON" <<'EOF' || fail "replay response leaked issuance (see above)"
import json, sys
d = json.load(open(sys.argv[1]))
assert "token" not in d and "deviceId" not in d, "replay must not re-issue"
print("replay issued nothing (single-issuance holds)")
EOF
echo "PASS phase 6 (provisional info + bind-assert + dual-confirm enroll 201 + poll 202/200-once; replay rejection below)"
# Provisional enrollment is allowed; approval reserves the ONE active slot.
# A distinct second request must fail authenticated approval409 and never issue.
python3 - "$ENROLL_BODY" "$TDSH/capacity-body.json" <<'EOF'
import json, secrets, sys
body = json.load(open(sys.argv[1])); body['deviceAlias'] = 'capacity-test-watch'
body['enrollmentSecret'] = secrets.token_urlsafe(32)
json.dump(body, open(sys.argv[2], 'w'))
EOF
code_capacity=$(curl -s --cacert "$TURNKEY_CERT" -o "$TDSH/capacity-enroll.json" -w '%{http_code}' "$LAN_BASE/pair/enroll" -H 'Content-Type: application/json' -H 'X-Fingerprint-Confirmed: true' --data @"$TDSH/capacity-body.json") || fail 'capacity enrollment probe failed'
[ "$code_capacity" = 201 ] || fail "provisional capacity enrollment: want 201, got $code_capacity"
python3 - "$TDSH/capacity-enroll.json" "$TDSH/capacity-body.json" "$TDSH" <<'EOF'
import json, sys
request = json.load(open(sys.argv[1]))['requestId']; secret = json.load(open(sys.argv[2]))['enrollmentSecret']
json.dump({'requestId': request, 'approve': True, 'fingerprintConfirmed': True}, open(sys.argv[3]+'/capacity-approve.json','w'))
json.dump({'requestId': request, 'approve': False, 'fingerprintConfirmed': True}, open(sys.argv[3]+'/capacity-deny.json','w'))
json.dump({'requestId': request, 'enrollmentSecret': secret}, open(sys.argv[3]+'/capacity-poll.json','w'))
EOF
code_capacity_approval=$(curl -s -b "$COOKIE_JAR" -o "$TDSH/capacity-refusal.json" -w '%{http_code}' "${BOUND_URL}admin/pair/approval" -H 'Content-Type: application/json' --data @"$TDSH/capacity-approve.json") || fail 'capacity approval probe failed'
[ "$code_capacity_approval" = 409 ] || fail "one active watch approval capacity: want 409, got $code_capacity_approval"
code_capacity_poll=$(curl -s --cacert "$TURNKEY_CERT" -o "$TDSH/capacity-poll-result.json" -w '%{http_code}' "$LAN_BASE/pair/poll" -H 'Content-Type: application/json' --data @"$TDSH/capacity-poll.json") || fail 'capacity poll probe failed'
[ "$code_capacity_poll" = 202 ] || fail "unapproved second watch cannot issue: want 202, got $code_capacity_poll"
python3 - "$TDSH/capacity-poll-result.json" <<'EOF' || fail 'capacity refusal leaked device issuance'
import json, sys
body = json.load(open(sys.argv[1])); assert 'token' not in body and 'deviceId' not in body
EOF
code_capacity_deny=$(curl -s -b "$COOKIE_JAR" -o "$TDSH/capacity-denied.json" -w '%{http_code}' "${BOUND_URL}admin/pair/approval" -H 'Content-Type: application/json' --data @"$TDSH/capacity-deny.json") || fail 'capacity pending cleanup failed'
[ "$code_capacity_deny" = 200 ] || fail "capacity pending cleanup: want 200, got $code_capacity_deny"
echo 'PASS phase 6b (one active watch: distinct provisional enrollment201 -> approval409 -> no issuance202 -> deny cleanup200)'

echo "== phase 7: authenticated device surface, pinned TLS (full only) =="
# Every device call uses pinned TLS (--cacert = H turnkey cert) + the
# per-device token header. Secrets travel in files/headers only.
DTOKEN=$(cat "$DEVICE_TOKEN_FILE")
# POSIX-sh device caller: auth_curl <path> <out-file> [extra curl args...]
# prints the HTTP code; the token travels in a header only (never a URL).
auth_curl() {
  _ac_path=$1; _ac_out=$2; shift 2
  curl -s --cacert "$TURNKEY_CERT" -H "X-Bridge-Token: $DTOKEN" --cacert "$TURNKEY_CERT" -o "$_ac_out" -w '%{http_code}' "$LAN_BASE$_ac_path" "$@"
}
HEALTH_JSON="$TDSH/health.json"
code_health=$(auth_curl "/watch/health" "$HEALTH_JSON" -w '%{http_code}') || fail "device health failed"
[ "$code_health" = "200" ] || fail "device health: want 200, got $code_health"
python3 - "$HEALTH_JSON" <<'EOF' || fail "health shape wrong (see above)"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("ok") is True and d.get("dsh") == "up", "health"
assert "voice" in d and "queue" in d and "pending" in d, "health keys"
print("health ok: voice=%s queue=%s pending=%s" % (d["voice"], d["queue"], d["pending"]))
EOF
# Fail-closed legs: wrong token, and token-in-URL (must never ride query).
code_badtoken=$(curl -s --cacert "$TURNKEY_CERT" -o /dev/null -w '%{http_code}' --cacert "$TURNKEY_CERT" -H 'X-Bridge-Token: wrong-token-00000000000000000000' "$LAN_BASE/watch/health") || fail "bad-token probe failed"
[ "$code_badtoken" = "401" ] || fail "bad token: want 401, got $code_badtoken"
code_tokenurl=$(curl -s --cacert "$TURNKEY_CERT" -o /dev/null -w '%{http_code}' --cacert "$TURNKEY_CERT" -H "X-Bridge-Token: $DTOKEN" "$LAN_BASE/watch/health?token=abc") || fail "token-in-URL probe failed"
[ "$code_tokenurl" = "401" ] || fail "token in URL: want 401, got $code_tokenurl"
BIND_JSON="$TDSH/binding.json"
code_binding=$(auth_curl "/watch/binding" "$BIND_JSON" -w '%{http_code}') || fail "binding probe failed"
[ "$code_binding" = "200" ] || fail "binding: want 200, got $code_binding"
python3 - "$BIND_JSON" "$DEVICE_ID" <<'EOF' || fail "binding shape wrong (see above)"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("deviceId") == sys.argv[2], "deviceId must equal the enrolled device"
assert isinstance(d.get("watchedSessionId"), str), "watchedSessionId must be a string ('' when none)"
assert isinstance(d.get("autoFollow"), bool), "autoFollow must be a bool"
print("binding ok: watchedSessionId=%r autoFollow=%s" % (d["watchedSessionId"], d["autoFollow"]))
EOF
# The binding call above exercised the REAL host session list over the SDK
# wire (H watchedSessionFor -> host.listSessions with a real AbortSignal +
# bounded timeout). Keyless temp profile has no sessions, so the truthful
# result is watchedSessionId:'' (empty-list, never a fabricated id).
WSID=$(python3 -c "import json;print(json.load(open('$BIND_JSON'))['watchedSessionId'])")
if [ -z "$WSID" ]; then
  echo "note: no watched session in keyless temp profile (empty host list, honest). Live prompt/streaming legs stay PENDING below."
  HAVE_SESSION=0
else
  echo "note: watched session present (device-selected, never typed)."
  HAVE_SESSION=1
fi
CAPS_JSON="$TDSH/caps.json"
code_caps=$(auth_curl "/watch/capabilities" "$CAPS_JSON" -w '%{http_code}') || fail "capabilities probe failed"
[ "$code_caps" = "200" ] || fail "capabilities: want 200, got $code_caps"
python3 - "$CAPS_JSON" <<'EOF' || fail "capabilities shape wrong (see above)"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("ok") is True and isinstance(d.get("characterId"), str), "caps"
print("capabilities ok: characterId=%s" % d["characterId"])
EOF
CMD_JSON="$TDSH/cmd.json"
code_cmd=$(auth_curl "/watch/command" "$CMD_JSON" -w '%{http_code}' -H 'Content-Type: application/json' --data '{"cmd":"ping"}') || fail "command ping failed"
[ "$code_cmd" = "200" ] || fail "command ping: want 200, got $code_cmd"
python3 - "$CMD_JSON" <<'EOF' || fail "command ping shape wrong (see above)"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("ok") is True and d.get("pong") is True, "ping"
print("command ping ok (scoped device request)")
EOF
echo "PASS phase 7 (health/binding/capabilities/command shapes; fail-closed 401s hold)"
echo "== phase 7b: watch SSE hello + snapshot (deadline-bounded, full only) =="
SSE_FILE="$TDSH/sse.txt"
# --max-time bounds the open stream; curl exits 28 on expiry AFTER headers
# were received, so the exit is ignored and the frames are asserted instead.
curl -s --cacert "$TURNKEY_CERT" -H "X-Bridge-Token: $DTOKEN" -N --max-time 20 "$LAN_BASE/watch/stream" >"$SSE_FILE" 2>/dev/null &
WATCH_SSE_PID=$!; OWN_PIDS="$OWN_PIDS $WATCH_SSE_PID"
for _i in $(seq 1 10); do grep -q '"snapshot"' "$SSE_FILE" && break; sleep 1; done
# Exact fresh watch lifecycle: hello voiceActive:false -> watch-owned start.
code_start=$(auth_curl '/watch/command' "$TDSH/watch-start.json" -H 'Content-Type: application/json' --data '{"cmd":"start","sessionOwnedByApp":true}') || fail 'watch start failed'
[ "$code_start" = 200 ] || fail "watch fresh start: want 200, got $code_start"
for muted in true false; do
  code_mute=$(auth_curl '/watch/command' "$TDSH/watch-mute-$muted.json" -H 'Content-Type: application/json' --data "{\"cmd\":\"mute\",\"muted\":$muted}") || fail 'watch mute failed'
  [ "$code_mute" = 200 ] || fail "watch mute: want 200, got $code_mute"
done
code_projects=$(auth_curl '/watch/command' "$TDSH/watch-projects.json" -H 'Content-Type: application/json' --data '{"cmd":"projects"}') || fail 'watch projects failed'
[ "$code_projects" = 200 ] || fail "watch projects: want 200, got $code_projects"
code_stop=$(auth_curl '/watch/command' "$TDSH/watch-stop.json" -H 'Content-Type: application/json' --data '{"cmd":"stop","sessionOwnedByApp":true}') || fail 'watch stop failed'
[ "$code_stop" = 200 ] || fail "watch stop: want 200, got $code_stop"
code_start=$(auth_curl '/watch/command' "$TDSH/watch-restart.json" -H 'Content-Type: application/json' --data '{"cmd":"start","sessionOwnedByApp":true}') || fail 'watch restart failed'
[ "$code_start" = 200 ] || fail "watch restart: want 200, got $code_start"
sleep 1
kill "$WATCH_SSE_PID" 2>/dev/null || true
python3 - "$SSE_FILE" "$TDSH/watch-projects.json" <<'EOF' || fail 'actual watch fresh start/stop/mute choreography missing from SSE'
import json, sys
frames = [json.loads(line[5:]) for line in open(sys.argv[1]) if line.startswith('data:')]
hello = next(f for f in frames if f.get('t') == 'hello')
assert hello.get('voiceActive') is False, 'fresh hello must not claim active voice'
assert hello.get('features', {}).get('queueReorder') is False, 'rc.1 reorder must be advertised unavailable'
assert any(f.get('t') in ('voice', 'state') and f.get('active') is True for f in frames), 'watch start enabled state missing'
assert any(f.get('t') in ('voice', 'state') and f.get('active') is False for f in frames), 'watch stop disabled state missing'
assert any(f.get('t') in ('voice', 'state') and f.get('muted') is True for f in frames), 'mute state missing'
assert isinstance(json.load(open(sys.argv[2])).get('projects'), list), 'actual projects DTO missing'
print('fresh watch lifecycle PASS: initial disabled -> start -> mute/unmute -> stop -> restart; no Mac mic activation')
EOF
grep -q '"hello"' "$SSE_FILE" || fail "SSE missing hello frame"
grep -q '"snapshot"' "$SSE_FILE" || fail "SSE missing snapshot frame"
python3 - "$SSE_FILE" <<'EOF' || fail "SSE frame keys wrong (see above)"
import json, sys
frames = []
for line in open(sys.argv[1]):
    line = line.strip()
    if line.startswith("data:"):
        frames.append(json.loads(line[5:]))
kinds = [f.get("t") for f in frames]
assert "hello" in kinds and "snapshot" in kinds, kinds
hello = next(f for f in frames if f.get("t") == "hello")
assert "protocol" in hello and "queueDepth" in hello, "hello keys"
snap = next(f for f in frames if f.get("t") == "snapshot")
for key in ("voice", "session", "queue", "pending"):
    assert key in snap, "snapshot missing production key: " + key
print("SSE ok: frames=%s snapshot-keys=voice/session/queue/pending" % kinds)
EOF
echo "PASS phase 7b (SSE hello + snapshot exact keys)"

echo "== phase 7c: HOST_LLM routing via temp fixture adapter (full only) =="
# Unauthed fixture route must refuse (same requestRejection gate as admin).
code_fix_noauth=$(curl -s -o /dev/null -w '%{http_code}' "${BOUND_URL}fixture-llm/__run__") || fail "unauthed fixture probe failed"
[ "$code_fix_noauth" = "401" ] || fail "fixture unauth: want 401, got $code_fix_noauth"
FIXTURE_JSON="$TDSH/fixture.json"
code_fix=$(curl -s -b "$COOKIE_JAR" -o "$FIXTURE_JSON" -w '%{http_code}' --max-time 150 "${BOUND_URL}fixture-llm/__run__") || fail "fixture routing run failed"
[ "$code_fix" = "200" ] || { head -c 300 "$FIXTURE_JSON" >&2; echo >&2; fail "fixture routing: want 200, got $code_fix"; }
python3 - "$FIXTURE_JSON" <<'EOF' || fail "HOST_LLM routing proof failed (see above)"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("ok") is True, "ok"
assert isinstance(d.get("sessionId"), str) and d["sessionId"], "real session id"
assert d.get("routableIncludesFixture") is True, "fixture-local must be routable"
assert d.get('credentialEnvKeys') == [], 'actual SDK child inherited credential environment names'
assert set(d.get('routable', [])) == {'fixture-local'}, 'keyless SDK must expose no routable real provider'
assert d.get("userFound") is True, "durable agent user record must contain the synthetic phrase"
assert d.get("assistantFound") is True, "assistant follow text must match the fixture echo"
print("HOST_LLM routing ok: session=%s.. frames=%d" % (d["sessionId"][:8], d.get("frames", 0)))
EOF
FIXTURE_SESSION=$(python3 -c "import json;print(json.load(open('$FIXTURE_JSON'))['sessionId'])")
ROUTING_PASS=1
echo "ROUTING_PASS leg green (session $FIXTURE_SESSION; synthetic phrase only, never product audio)"
# Binding must target the REAL session id (no typed ids, no empty claim).
BIND_JSON2="$TDSH/binding2.json"
code_binding2=$(auth_curl "/watch/binding" "$BIND_JSON2" -w '%{http_code}') || fail "binding re-probe failed"
[ "$code_binding2" = "200" ] || fail "binding re-probe: want 200, got $code_binding2"
python3 - "$BIND_JSON2" "$FIXTURE_SESSION" <<'EOF' || fail "binding does not target the real session (see above)"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("watchedSessionId") == sys.argv[2], \
    "binding must equal the real session (got %r)" % (d.get("watchedSessionId"),)
print("binding targets the real session id")
EOF
# Wrong-session Cappi is refused (409, no effect); the bound session clears.
CAPPI_WRONG="$TDSH/cappi-wrong.json"
code_cappi_wrong=$(auth_curl "/watch/cappi" "$CAPPI_WRONG" -w '%{http_code}' -H 'Content-Type: application/json' --data '{"sessionId":"mismatch-session-TEST-FIXTURE","action":"clear"}') || fail "wrong-session cappi probe failed"
[ "$code_cappi_wrong" = "409" ] || fail "wrong-session cappi: want 409, got $code_cappi_wrong"
CAPPI_OK="$TDSH/cappi-ok.json"
code_cappi_ok=$(auth_curl "/watch/cappi" "$CAPPI_OK" -w '%{http_code}' -H 'Content-Type: application/json' --data "{\"sessionId\":\"$FIXTURE_SESSION\",\"action\":\"clear\"}") || fail "bound-session cappi probe failed"
[ "$code_cappi_ok" = "200" ] || fail "bound-session cappi clear: want 200, got $code_cappi_ok"
python3 - "$CAPPI_OK" <<'EOF' || fail "cappi clear shape wrong (see above)"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("ok") is True and d.get("action") is None, "bound clear"
print("cappi binding gate ok (wrong 409, bound clear 200)")
EOF
# Settings UI surface WITHOUT a browser: the installed watch client asset
# must carry the real approval strings (fingerprint compare + approve +
# revoke + voice setup). Unit specs cover behavior; this proves staging.
WCLIENT=$(find "$DSH_HOME/profiles/web/node_modules/dsh-watch" -name 'client.js' 2>/dev/null | head -n 1)
[ -n "$WCLIENT" ] || fail "installed watch client asset missing (tar staging broken)"
for needle in fingerprintConfirmed approve revoke consent; do
  grep -q "$needle" "$WCLIENT" || fail "watch client asset lacks Settings string: $needle"
done
echo "Settings UI asset check ok (client carries fingerprint/approve/revoke/consent; no browser launched)"
# Execute the actual SDK-registered tool using the real resolved session
# agent. The HTTP clear above is a binding gate, NOT model-tool proof.
CAPPI_SSE="$TDSH/cappi-sse.txt"
curl -s --cacert "$TURNKEY_CERT" -H "X-Bridge-Token: $DTOKEN" --cacert "$TURNKEY_CERT" -N --max-time 15 "$LAN_BASE/watch/stream" >"$CAPPI_SSE" 2>/dev/null &
CAPPI_PID=$!; OWN_PIDS="$OWN_PIDS $CAPPI_PID"
sleep 1
CAPPI_TOOL_JSON="$TDSH/cappi-tool.json"
code_tool=$(curl -s -b "$COOKIE_JAR" -o "$CAPPI_TOOL_JSON" -w '%{http_code}' "${BOUND_URL}fixture-llm/__cappi__") || fail 'registered Cappi SDK execution failed'
[ "$code_tool" = 200 ] || fail 'registered Cappi SDK execution refused'
sleep 1
CAPPI_STATE="$TDSH/cappi-state.json"
code_state=$(auth_curl '/watch/state' "$CAPPI_STATE") || fail 'Cappi state probe failed'
[ "$code_state" = 200 ] || fail 'Cappi state unavailable'
kill "$CAPPI_PID" 2>/dev/null || true
python3 - "$CAPPI_TOOL_JSON" "$CAPPI_STATE" "$CAPPI_SSE" <<'EOF' || fail 'registered Cappi tool did not animate real state/SSE'
import json, sys
result, state = (json.load(open(p)) for p in sys.argv[1:3])
assert result.get('ok') is True and result.get('agentBound') is True, 'actual registered SDK tool failed'
assert state.get('cappiAction') == 'dance', 'registered tool did not update actual state'
frames = [json.loads(line[5:]) for line in open(sys.argv[3]) if line.startswith('data:')]
assert any(f.get('t') == 'cappi' and f.get('action') == 'dance' for f in frames), 'dance missing from actual SSE'
print('registered cappi_action PASS: real SDK agent binding -> dance state + live SSE')
EOF
# Real watch command contract against the SDK-owned fixture session.
MODEL_JSON="$TDSH/watch-models.json"
code_models=$(auth_curl '/watch/command' "$MODEL_JSON" -H 'Content-Type: application/json' --data "{\"cmd\":\"models\",\"sessionId\":\"$FIXTURE_SESSION\"}") || fail 'watch models failed'
[ "$code_models" = 200 ] || fail "watch models: want 200, got $code_models"
python3 - "$MODEL_JSON" "$TDSH/set-model.json" "$FIXTURE_SESSION" <<'EOF' || fail 'fixture model catalog not reachable from actual watch command'
import json, sys
state = json.load(open(sys.argv[1]))
option = next(o for o in state['options'] if o.get('provider') == 'fixture-local')
json.dump({'cmd': 'set-model', 'sessionId': sys.argv[3], 'modelId': option['value']}, open(sys.argv[2], 'w'))
EOF
code_model=$(auth_curl '/watch/command' "$TDSH/model-selected.json" -H 'Content-Type: application/json' --data @"$TDSH/set-model.json") || fail 'watch model selection failed'
[ "$code_model" = 200 ] || fail "watch set-model: want 200, got $code_model"
code_qmove=$(auth_curl '/watch/command' "$TDSH/queue-move.json" -H 'Content-Type: application/json' --data "{\"cmd\":\"queue-move\",\"sessionId\":\"$FIXTURE_SESSION\"}") || fail 'unsupported reorder probe failed'
[ "$code_qmove" = 501 ] || fail "rc.1 reorder must refuse 501, got $code_qmove"
code_badopen=$(auth_curl '/watch/command' "$TDSH/open-mac-invalid.json" -H 'Content-Type: application/json' --data "{\"cmd\":\"open-mac\",\"sessionId\":\"$FIXTURE_SESSION\",\"url\":\"file:///synthetic.invalid/forbidden\"}") || fail 'invalid opener probe failed'
[ "$code_badopen" = 400 ] || fail "invalid open-mac URL must refuse 400 without opening anything, got $code_badopen"
code_cancel_wrong=$(auth_curl '/watch/command' "$TDSH/cancel-wrong.json" -H 'Content-Type: application/json' --data '{"cmd":"cancel","sessionId":"mismatch-session-TEST-FIXTURE"}') || fail 'wrong-session cancel probe failed'
[ "$code_cancel_wrong" = 409 ] || fail "wrong cancel binding: want 409, got $code_cancel_wrong"
code_cancel=$(auth_curl '/watch/command' "$TDSH/cancel-idle.json" -H 'Content-Type: application/json' --data "{\"cmd\":\"cancel\",\"sessionId\":\"$FIXTURE_SESSION\"}") || fail 'bound idle cancel failed'
[ "$code_cancel" = 200 ] || fail "bound idle cancel: want 200, got $code_cancel"
callback_leg() {
  _kind="$1"
  code_callback=$(curl -s -b "$COOKIE_JAR" -o "$TDSH/callback-$_kind-start.json" -w '%{http_code}' "${BOUND_URL}fixture-llm/__callback__?phase=$_kind") || fail 'fixture callback prompt failed'
  [ "$code_callback" = 200 ] || fail "fixture callback start: want 200, got $code_callback"
  _pending=0
  for _i in $(seq 1 25); do
    code_pending=$(auth_curl '/watch/state' "$TDSH/callback-pending.json") || fail 'callback pending state read failed'
    [ "$code_pending" = 200 ] || fail 'callback state unavailable'
    if python3 - "$TDSH/callback-pending.json" "$TDSH/callback-answer.json" "$FIXTURE_SESSION" "$_kind" <<'EOF'
import json, sys
state = json.load(open(sys.argv[1]))
kind = 'approval' if sys.argv[4] == 'approval' else 'ask'
items = [item for item in state.get('pending', []) if item.get('kind') == kind]
if len(items) != 1: sys.exit(1)
json.dump({'cmd': 'approve', 'sessionId': sys.argv[3], 'requestId': items[0]['id'], 'choiceId': 'allowed-once' if kind == 'approval' else 'fixture-answer'}, open(sys.argv[2], 'w'))
EOF
    then _pending=1; break; fi
    sleep 1
  done
  [ "$_pending" = 1 ] || fail "actual SDK $_kind waterfall never appeared on bound watch"
  code_answer=$(auth_curl '/watch/command' "$TDSH/callback-$_kind-answer.json" -H 'Content-Type: application/json' --data @"$TDSH/callback-answer.json") || fail 'callback answer failed'
  [ "$code_answer" = 200 ] || fail "callback answer: want 200, got $code_answer"
  _proved=0
  for _i in $(seq 1 20); do
    code_cbproof=$(curl -s -b "$COOKIE_JAR" -o "$TDSH/callback-$_kind-proof.json" -w '%{http_code}' "${BOUND_URL}fixture-llm/__callback__?phase=proof") || fail 'SDK callback proof read failed'
    if [ "$code_cbproof" = 200 ] && python3 "$ROOT/tools/lib/callback-proof.py" "$TDSH/callback-$_kind-proof.json" > "$TDSH/callback-proof-summary.txt" 2>/dev/null; then _proved=1; break; fi
    sleep 1
  done
  [ "$_proved" = 1 ] || fail "actual $_kind callback did not complete exactly one real SDK tool result"
  cat "$TDSH/callback-proof-summary.txt"
  code_late=$(auth_curl '/watch/command' "$TDSH/callback-late.json" -H 'Content-Type: application/json' --data @"$TDSH/callback-answer.json") || fail 'late callback answer probe failed'
  [ "$code_late" = 404 ] || fail "already-settled callback must reject late answer404, got $code_late"
}
callback_leg approval
callback_leg question
echo 'actual watch controls PASS: model selection, idle cancel, real model-requested approval/question SDK callbacks, binding refusal, unsupported reorder501, unsafe opener400 (no opener used)'
echo "PASS phase 7c (HOST_LLM routing + registered Cappi dance + real-session binding + Settings asset + watch controls)"

echo "== phase 8: mic preflight (fail-closed) + conditional PCM leg =="
STREAM_ID="harness-$(python3 -c "import secrets;print(secrets.token_hex(4))")"
MICSTART_JSON="$TDSH/micstart.json"
MICSTART_BODY="$TDSH/micstart-body.json"
python3 - "$MICSTART_BODY" "$STREAM_ID" <<'EOF' || fail "micstart body build failed"
import json, sys
json.dump({"streamId": sys.argv[2]}, open(sys.argv[1], "w"))
EOF
code_micstart=$(auth_curl "/watch/mic/start" "$MICSTART_JSON" -w '%{http_code}' -H 'Content-Type: application/json' --data @"$MICSTART_BODY") || fail "mic preflight failed"
case "$code_micstart" in
  409)
    echo "mic preflight 409 (no watched session / stream conflict: fail-closed, honest keyless state)"
    MIC_READY=0
    ;;
  503|499)
    echo "mic preflight $code_micstart (voice backend not ready / start aborted: fail-closed)"
    MIC_READY=0
    ;;
  200)
    echo "mic preflight 200 ready (session + native ASR both live)"
    MIC_READY=1
    ;;
  *)
    redact < "$MICSTART_JSON" | head -c 300 >&2; echo >&2
    fail "mic preflight: want 409/503/499 fail-closed (or 200 ready), got $code_micstart"
    ;;
esac
if [ "$MIC_READY" = "0" ]; then
  # Fail-closed must be MEANINGFUL: production error DTO carries
  # `error` (or `code`) + actionable message + retryable.
  python3 - "$MICSTART_JSON" <<'EOF' || fail "mic preflight refusal lacks actionable DTO (see above)"
import json, sys
d = json.load(open(sys.argv[1]))
err = d.get("error", d.get("code"))
assert isinstance(err, str) and err, "error/code"
assert isinstance(d.get("message"), str) and len(d["message"]) >= 8, "message"
assert isinstance(d.get("retryable"), bool), "retryable"
print("preflight refusal meaningful: error=%s retryable=%s" % (err, d["retryable"]))
EOF
fi
if [ "$MIC_READY" = "1" ]; then
  # Pre-setup 200 is unexpected (backend cannot be ready before explicit
  # voice setup): do NOT upload here. The stream is closed by stopping the
  # boot below, and the REAL generated-speech leg runs after the native
  # gate + /admin/voice/setup in phase 9b with a fresh streamId. Sine-wave
  # uploads never prove recognition (the recognizer cannot recognize a
  # sine), so no sine fixture is ever uploaded on this path.
  echo "note: pre-setup mic preflight 200 (unexpected before voice setup) — deferring PCM to the phase 9b generated-speech leg; no sine uploaded"
  DELIVERED=0
else
  echo "PENDING PCM leg pre-setup: preflight not ready ($code_micstart) — expected before explicit voice setup. Receipt/ACK semantics run after the native gate (phase 9b), never faked."
  DELIVERED=0
fi
NATIVE_PASS=0
NATIVE_GATE="pending"
NATIVE_CLAIMS_OK=0

echo "== phase 9: native helper + OS speech report (diagnostic, full only) =="
# Resolve the INSTALLED voice resources (what npm actually staged).
VRES=$(dirname "$(find "$DSH_HOME/profiles/web/node_modules/dsh-live-voice-kokoro" -name 'watch-asr.manifest.json' 2>/dev/null | head -n 1)" 2>/dev/null || true)
[ -n "$VRES" ] || fail "installed voice resources missing (tar staging broken)"
VHELP="$VRES/bin/watch-asr"
SNAP_HELP="$PACK_SRC/dsh-live-voice/resources/bin/watch-asr"
HELPER_BLOCKED=0
if [ -f "$VHELP" ]; then
  codesign --verify --strict "$VHELP" 2>"$TDSH/codesign-check.err" || fail 'installed native helper signature invalid'
  otool -l "$VHELP" | grep -q 'minos 13.0' || fail 'installed native helper must target macOS 13.0'
  echo 'installed native helper ad-hoc signature verified; minimum OS 13.0 (both architectures compiled; only current host executed)'
  HELP_UNDER_TEST="$VHELP"
  echo "helper present (installed): $VHELP ($(du -h "$VHELP" | cut -f1))"
elif [ -f "$SNAP_HELP" ]; then
  HELP_UNDER_TEST="$SNAP_HELP"
  HELPER_BLOCKED=1
  echo "BLOCKED helper-staging: voice tar lacks resources/bin/watch-asr (nested .gitignore beats files[]; V packaging next-fix). Snapshot-built binary used for static checks only — installability stays BLOCKED."
else
  HELPER_BLOCKED=1
  HELP_UNDER_TEST=""
  echo "BLOCKED helper-missing: no watch-asr binary installed or built (V next-fix)"
fi
if [ "$SCRIPT_SHIPPED" = "0" ]; then
  HELPER_BLOCKED=1
  echo "BLOCKED helper-script: voice tar lacks scripts/build-watch-helpers.sh, so the compile-on-target fallback cannot run from a tar install (V packaging next-fix: add scripts to files[])."
fi
if [ -n "$HELP_UNDER_TEST" ]; then
  ARCHES=$(lipo -archs "$HELP_UNDER_TEST" 2>/dev/null || file -b "$HELP_UNDER_TEST" | head -c 120)
  echo "helper arch: $ARCHES"
fi
# Manifest truth: snapshot SOURCE sha (pack truth) + snapshot BINARY sha
# (what V built) vs the manifest, PLUS header-parsed arch vs the manifest
# claim (parsed Mach-O bytes, never a basename or an untrusted string).
# Installed-binary comparison runs only when staging actually shipped it.
python3 - "$VRES/watch-asr.manifest.json" "$VRES/watch-asr.swift" "$VHELP" "$VHELP" <<'EOF' || fail "helper manifest truth check failed"
import hashlib, json, os, struct, sys
m = json.load(open(sys.argv[1]))
assert m.get("binary") == "resources/bin/watch-asr", "manifest binary path"
assert m.get("source") == "resources/watch-asr.swift", "manifest source path"
for key in ("sourceSha256", "binarySha256", "architectures", "universal"):
    assert key in m, "manifest missing provenance key: " + key
src_sha = hashlib.sha256(open(sys.argv[2], "rb").read()).hexdigest()
assert src_sha == m.get("sourceSha256"), "snapshot source SHA mismatch: manifest is stale"
def macho_archs(path):
    raw = open(path, "rb").read(8192)
    if len(raw) < 8:
        return None
    magic = raw[:4]
    # thin LE (macOS build output): cputype at bytes 4..8
    if magic in (b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe"):
        (cputype,) = struct.unpack_from("<I", raw, 4)
        return {0x01000007: ["x86_64"], 0x0100000C: ["arm64"]}.get(cputype)
    # thin BE
    if magic in (b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf"):
        (cputype,) = struct.unpack_from(">I", raw, 4)
        return {0x01000007: ["x86_64"], 0x0100000C: ["arm64"]}.get(cputype)
    # FAT/FAT64: walk nfat_arch slice cputypes (big-endian headers)
    if magic in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
        (nfat,) = struct.unpack_from(">I", raw, 4)
        assert 0 < nfat <= 64, "fat nfat_arch out of bounds"
        entry = 20 if magic == b"\xca\xfe\xba\xbe" else 32
        out = set()
        for i in range(nfat):
            (cputype,) = struct.unpack_from(">I", raw, 8 + i * entry)
            out.add({0x01000007: "x86_64", 0x0100000C: "arm64"}.get(cputype, "cputype-%#x" % cputype))
        return sorted(out)
    return None
snap_bin, installed_bin = sys.argv[3], sys.argv[4]
actual = macho_archs(snap_bin) if os.path.isfile(snap_bin) else None
if actual is None and os.path.isfile(snap_bin):
    raise SystemExit("snapshot binary Mach-O header unparseable")
if actual is not None:
    bin_sha = hashlib.sha256(open(snap_bin, "rb").read()).hexdigest()
    assert bin_sha == m.get("binarySha256"), "snapshot binary SHA mismatch: manifest is stale"
    claimed = m.get("architectures")
    if isinstance(claimed, str):
        import re as _re
        claimed_list = [a for a in _re.split(r"[\s,+]+", claimed) if a]
    else:
        claimed_list = list(claimed)
    assert sorted(claimed_list) == sorted(actual), \
        "manifest arch != header-parsed payload (%r vs %r)" % (claimed_list, actual)
    # Universal policy (hard): a `universal` truthy claim with a thin
    # payload is a sham — fail, never bless for Intel.
    if m.get("universal"):
        assert len(actual) > 1, "manifest claims universal but payload is thin (%r): Intel would lack a slice" % (actual,)
    print("manifest truth ok: source=%s binary=%s arch=%s universal=%s"
          % (src_sha[:12], bin_sha[:12], "+".join(actual), m.get("universal")))
else:
    print("manifest source truth ok (%s); snapshot binary absent (not built here)" % src_sha[:12])
if os.path.isfile(installed_bin):
    i_sha = hashlib.sha256(open(installed_bin, "rb").read()).hexdigest()
    assert i_sha == m.get("binarySha256"), "installed binary SHA mismatch: staged tar != manifest"
    i_arch = macho_archs(installed_bin)
    assert i_arch is not None, "installed binary Mach-O header unparseable"
    print("installed binary matches manifest (%s arch=%s)" % (i_sha[:12], "+".join(i_arch)))
else:
    print("installed binary absent (staging gap, see BLOCKED above)")
EOF
UNIVERSAL=$(python3 -c "import json;print(json.load(open('$VRES/watch-asr.manifest.json'))['universal'])")
if [ "$UNIVERSAL" = "0" ]; then
  echo "note: helper is single-arch (arm64, universal=0). Intel Macs lack a runtime helper until the user compiles from source (CLT required) — user-requirement BLOCKED for x86_64, reported not edited."
fi
# --help is the ONLY helper invocation here: noncapturing self-check, run
# only when a binary exists (installed preferred, snapshot fallback).
if [ -n "$HELP_UNDER_TEST" ]; then
  "$HELP_UNDER_TEST" --help >/dev/null 2>&1
  HELP_CODE=$?
  [ "$HELP_CODE" = "0" ] || echo "note: helper --help exit=$HELP_CODE (noncapture self-check; capture legs stay pending)"
  echo "helper --help noncapture self-check exit=$HELP_CODE (no audio captured, no TCC touched)"
else
  HELP_CODE="n/a"
  echo "helper --help skipped (no binary; see BLOCKED above)"
fi
# Native gate from the PACKED helper diagnostic (phase 9a): run the binary
# under test with --status (read-only: never requests authorization, never
# reads stdin, never touches the Mac microphone). ONLY an explicit
# authorization=authorized + localeAvailable=true + onDeviceRecognition=true
# result proceeds to the authed POST /admin/voice/setup {consent:true}
# (same as the explicit user wizard; already-authorized performs no new OS
# prompt and no new TCC popup). Any other diagnostic -> STOP the native
# leg here, report need-consent, and never trigger an OS permission ask.
echo "-- native gate: packed-helper --status (read-only diagnostic) --"
NATIVE_STATUS_JSON="$TDSH/native-status.json"
if [ -n "$HELP_UNDER_TEST" ] && [ -x "$HELP_UNDER_TEST" ]; then
  if "$HELP_UNDER_TEST" --status >"$NATIVE_STATUS_JSON" 2>"$TDSH/native-status.err"; then
    NATIVE_STATUS_CODE=0
  else
    NATIVE_STATUS_CODE=$?
    echo "note: helper --status exit=$NATIVE_STATUS_CODE (non-zero diagnostic)"
  fi
else
  echo "BLOCKED native-gate: no helper binary to diagnose (see BLOCKED above); native leg stops without any OS prompt."
  NATIVE_STATUS_CODE="n/a"
  : >"$NATIVE_STATUS_JSON" || true
fi
if [ "$NATIVE_STATUS_CODE" = "0" ]; then
  python3 - "$NATIVE_STATUS_JSON" <<'EOF' || NATIVE_STATUS_CODE="shape"
import json, sys
d = json.load(open(sys.argv[1]))
auth = d.get("authorization", d.get("authorized"))
assert auth == "authorized" or d.get("authorized") is True, "authorization=%r (need authorized)" % (auth,)
assert d.get("localeAvailable") is True, "localeAvailable must be true"
assert d.get("onDeviceRecognition") is True, "onDeviceRecognition must be true"
print("native diagnostic ok: authorization=authorized locale=%s onDevice=true" % (d.get("locale"),))
EOF
fi
case "$NATIVE_STATUS_CODE" in
  0)
    NATIVE_GATE="authorized"
    echo "native gate AUTHORIZED (packed diagnostic; no mic activated, no new grant, no TCC popup)"
    ;;
  *)
    NATIVE_GATE="blocked-need-consent"
    echo "STOP native leg: packed diagnostic is not authorized (exit/shape=$NATIVE_STATUS_CODE) — need user consent in System Settings (Speech, plus Mic for Mac input). No --authorize run, no OS prompt triggered by this harness, no setup call made."
    ;;
esac
# Explicit user-wizard equivalent, ONLY on the authorized gate: authed
# POST /admin/voice/setup {consent:true} -> backend must report ready.
# Consumes the status response and verifies it is user-safe (identifier
# rows only: no tokens/secrets/session ids in the body).
VOICE_SETUP_JSON="$TDSH/voice-setup.json"
if [ "$NATIVE_GATE" = "authorized" ]; then
  code_setup=$(curl -s -b "$COOKIE_JAR" -o "$VOICE_SETUP_JSON" -w '%{http_code}' "${BOUND_URL}admin/voice/setup" -H 'Content-Type: application/json' --data '{"consent":true}') || fail "voice setup request failed"
  case "$code_setup" in
    200) echo "voice setup 200 (explicit-consent path, same as user wizard)" ;;
    *) redact < "$VOICE_SETUP_JSON" | head -c 300 >&2; echo >&2; fail "H BLOCK voice-setup: want 200, got $code_setup (backend refusing explicit consent; not a PENDING — exact H block above)" ;;
  esac
  python3 - "$VOICE_SETUP_JSON" <<'EOF' || fail "H BLOCK voice-setup shape wrong (see above): backend did not report ready on authorized consent"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("ok") is True, "ok"
assert d.get("status") in ("ready", "capturing"), "status=%r (want ready/capturing on authorized consent)" % (d.get("status"),)
for leak in ("token", "enrollmentSecret", "sessionId"):
    assert leak not in d, "setup response must be user-safe (leaks %s)" % leak
print("voice setup ready: status=%s (user-safe, no secrets)" % d.get("status"))
EOF
else
  echo "voice setup skipped (native gate $NATIVE_GATE; never auto-prompted)"
fi
# Native delivery leg (phase 9b): ONLY on authorized+ready. Fresh streamId,
# binding re-verified == FIXTURE_SESSION (the real session from the fixture
# provider adapter — keyless vanilla, actual SDK registration/prompt, no
# external keys), mic/start 200, then upload ACTUAL GENERATED speech PCM:
# system `say -o CAF "turnkey voice check"` -> afconvert to s16le/16k/mono
# WAV -> strip container to raw + 1s silence pad (robust VAD end-turn).
# Known synthetic phrase ONLY; no playback, no user mic, no public record
# file. The WATCH SSE stream stays open (private file) across the upload so
# the real follow + production TTS frames are observed on the exact
# current watch wire. Receipt requires ackFinals>=1 AND delivered=true —
# the ONLY accepted proof of server actual-final host admission (never the
# harness fixture.directPrompt path, which stays labelled routing-only).
if [ "$NATIVE_GATE" = "authorized" ]; then
  BIND_N_JSON="$TDSH/binding-native.json"
  code_bindn=$(auth_curl "/watch/binding" "$BIND_N_JSON" -w '%{http_code}') || fail "native binding re-probe failed"
  [ "$code_bindn" = "200" ] || fail "native binding: want 200, got $code_bindn"
  python3 - "$BIND_N_JSON" "$FIXTURE_SESSION" <<'EOF' || fail "V/H BLOCK native binding drifted (see above): watched session != real fixture session"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("watchedSessionId") == sys.argv[2], \
    "native mic must bind the real fixture session (got %r)" % (d.get("watchedSessionId"),)
print("native binding ok: mic will deliver to the real fixture session")
EOF
  NATIVE_ARM="$TDSH/native-arm.json"
  code_arm=$(curl -s -b "$COOKIE_JAR" -o "$NATIVE_ARM" -w '%{http_code}' "${BOUND_URL}fixture-llm/__native__?phase=arm") || fail 'native observation arm failed'
  [ "$code_arm" = 200 ] || fail 'native SDK cursor observation arm refused'
  NSTREAM="native-$(python3 -c "import secrets;print(secrets.token_hex(4))")"
  NMICSTART_JSON="$TDSH/nmicstart.json"
  NMICSTART_BODY="$TDSH/nmicstart-body.json"
  python3 - "$NMICSTART_BODY" "$NSTREAM" <<'EOF' || fail "native micstart body build failed"
import json, sys
json.dump({"streamId": sys.argv[2]}, open(sys.argv[1], "w"))
EOF
  code_nmicstart=$(auth_curl "/watch/mic/start" "$NMICSTART_JSON" -w '%{http_code}' -H 'Content-Type: application/json' --data @"$NMICSTART_BODY") || fail "native mic preflight failed"
  [ "$code_nmicstart" = "200" ] || { redact < "$NMICSTART_JSON" | head -c 300 >&2; echo >&2; fail "H/V BLOCK native mic/start: want 200 ready on authorized+bound session, got $code_nmicstart (exact block above; not silent PENDING)"; }
  echo "native mic preflight 200 ready (bound fixture session + live ASR input)"
  if command -v say >/dev/null 2>&1 && command -v afconvert >/dev/null 2>&1; then
    if say -o "$TDSH/native.caf" "turnkey voice check" 2>/dev/null && \
       afconvert -f WAVE -d LEI16@16000 -c 1 "$TDSH/native.caf" "$TDSH/native.wav" 2>/dev/null; then
      python3 - "$TDSH/native.wav" "$TDSH/native.pcm" <<'EOF' || fail "HARNESS BLOCK native wav strip failed (say/afconvert produced no usable PCM)"
import struct, sys
raw = open(sys.argv[1], "rb").read()
assert raw[:4] == b"RIFF" and raw[8:12] == b"WAVE", "not wav"
off, data = 12, None
while off + 8 <= len(raw):
    cid, size = raw[off:off+4], struct.unpack("<I", raw[off+4:off+8])[0]
    if cid == b"data":
        data = raw[off+8:off+8+size]
        break
    off += 8 + size + (size & 1)
assert data is not None and len(data) > 1000, "no pcm payload"
# 1s silence pad after the sentence (16000 samples s16le mono = 32000
# bytes) so the end-turn VAD reliably closes the utterance.
open(sys.argv[2], "wb").write(data + b"\x00" * 32000)
print("native speech PCM ok (%d bytes incl 1s pad; generated fixture only, never mic capture)" % (len(data) + 32000))
EOF
    else
      fail "HARNESS BLOCK native speech synthesis failed: say/afconvert produced no audio (exact harness block; fix toolchain, not silent PENDING)"
    fi
  else
    echo "BLOCKED tts-toolchain: say/afconvert unavailable on this host — native generated-speech leg cannot run (never sine, never mic)."
    NATIVE_GATE="blocked-no-toolchain"
  fi
fi
if [ "$NATIVE_GATE" = "authorized" ]; then
  # Live SSE capture across upload + follow window (private file, never
  # logged verbatim): proves the real sessionController follow
  # (assistant/running on the exact current watch wire) plus production
  # system-TTS speech-started/audio(pcmBase64>0)/audio-done frames from the
  # REAL native synth (voiceService.synthesize path), not fixture fake.
  NATIVE_SSE="$TDSH/native-sse.txt"
  curl -s --cacert "$TURNKEY_CERT" -H "X-Bridge-Token: $DTOKEN" --cacert "$TURNKEY_CERT" -N --max-time 120 "$LAN_BASE/watch/stream" >"$NATIVE_SSE" 2>/dev/null &
  NATIVE_SSE_PID=$!
  OWN_PIDS="$OWN_PIDS $NATIVE_SSE_PID"
  NRECEIPT_JSON="$TDSH/nreceipt.json"
  code_nmic=$(curl -s --cacert "$TURNKEY_CERT" -H "X-Bridge-Token: $DTOKEN" --cacert "$TURNKEY_CERT" -o "$NRECEIPT_JSON" -w '%{http_code}' --max-time 90 -H 'Content-Type: application/octet-stream' -H 'X-Sample-Rate: 16000' -H 'X-Channels: 1' -H 'X-EOF: 1' --data-binary "@$TDSH/native.pcm" "$LAN_BASE/watch/mic?streamId=$NSTREAM") || { kill "$NATIVE_SSE_PID" 2>/dev/null || true; fail "native PCM upload failed"; }
  [ "$code_nmic" = "200" ] || { kill "$NATIVE_SSE_PID" 2>/dev/null || true; redact < "$NRECEIPT_JSON" | head -c 300 >&2; echo >&2; fail "H/V BLOCK native PCM upload: want 200, got $code_nmic (exact block above)"; }
  python3 - "$NRECEIPT_JSON" "$NSTREAM" <<'EOF' || { echo "H/V BLOCK native receipt shape wrong (see above)" >&2; exit 1; }
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("streamId") == sys.argv[2], "streamId echo"
assert isinstance(d.get("txChunks"), int) and d["txChunks"] > 0, "txChunks>0 (counters, claim 6)"
assert isinstance(d.get("txBytes"), int) and d["txBytes"] > 0, "txBytes>0 (counters, claim 6)"
assert isinstance(d.get("ackFinals"), int) and d["ackFinals"] >= 1, \
    "ackFinals>=1 REQUIRED (server actual-final host admission; got %r)" % (d.get("ackFinals"),)
assert d.get("delivered") is True, "delivered must be true (durable user record admitted via real host prompt)"
assert d.get('drafted', False) is False, 'a submitted native prompt cannot also be a question draft (optional absent means false)'
print("native receipt ok: txChunks=%d txBytes=%d ackFinals=%d delivered=true (actual ASR final, never fixture.directPrompt)"
      % (d["txChunks"], d["txBytes"], d["ackFinals"]))
EOF
  ACKS=$(python3 -c "import json;print(json.load(open('$NRECEIPT_JSON'))['ackFinals'])")
  DELIVERED=1
  # Bounded follow/TTS window: the fixture-model reply + production TTS
  # arrive after host admission; wait up to ~45s for the frames, then
  # assert the 9 native claims over receipt + SSE (durable user record is
  # proven by ackFinals>=1: onInputEvent increments ONLY after a successful
  # real host submitUserText, which creates the durable agent user record;
  # draft/silence/failure paths never increment).
  sleep 45
  kill "$NATIVE_SSE_PID" 2>/dev/null || true
  sleep 1
  if kill -0 "$NATIVE_SSE_PID" 2>/dev/null; then kill -9 "$NATIVE_SSE_PID" 2>/dev/null || true; fi
  NATIVE_PROOF="$TDSH/native-proof.json"
  code_proof=$(curl -s -b "$COOKIE_JAR" -o "$NATIVE_PROOF" -w '%{http_code}' "${BOUND_URL}fixture-llm/__native__?phase=proof") || fail 'native SDK observation failed'
  [ "$code_proof" = 200 ] || fail 'native SDK observation refused'
  chmod 600 "$NATIVE_PROOF"
  python3 "$ROOT/tools/lib/native-proof.py" "$NATIVE_PROOF" "$NRECEIPT_JSON" "$NATIVE_SSE" || fail 'NATIVE VERIFY BLOCK: final/new durable user/completed new assistant/production speechId correlation failed (no stale snapshot PASS)'
  NATIVE_CLAIMS_OK=9
  NATIVE_PASS=1
  echo "NATIVE_PASS: 9/9 native claims green (real ASR receipt + follow + production TTS; fake-ASR routing stays a separate label)"
  # Explicit new RECORD with generated SILENCE, never a microphone. A real
  # helper no-speech event must produce ack0/error, not false THINKING/closed.
  SILENT_STREAM="silence-$(python3 -c 'import secrets; print(secrets.token_hex(4))')"
  python3 - "$TDSH/silence.pcm" <<'EOF'
import sys
open(sys.argv[1], 'wb').write(bytes(32000))  # generated 1s PCM16LE mono @16k
EOF
  code_silent_start=$(auth_curl '/watch/mic/start' "$TDSH/silence-start.json" -H 'Content-Type: application/json' --data "{\"streamId\":\"$SILENT_STREAM\"}") || fail 'silence stream preflight failed'
  [ "$code_silent_start" = 200 ] || fail "explicit silence record preflight: want 200, got $code_silent_start"
  code_silent=$(auth_curl "/watch/mic?streamId=$SILENT_STREAM" "$TDSH/silence-receipt.json" --max-time 50 -X POST -H 'Content-Type: application/octet-stream' -H 'X-Sample-Rate: 16000' -H 'X-Channels: 1' -H 'X-EOF: 1' --data-binary @"$TDSH/silence.pcm") || fail 'native silence EOF did not settle within bound'
  case "$code_silent" in 200|503) ;; *) fail "no-speech status: want actionable 200/503 receipt, got $code_silent" ;; esac
  code_silent_proof=$(curl -s -b "$COOKIE_JAR" -o "$TDSH/silence-proof.json" -w '%{http_code}' "${BOUND_URL}fixture-llm/__native__?phase=proof") || fail 'silence actual SDK proof unavailable'
  [ "$code_silent_proof" = 200 ] || fail 'silence actual SDK proof refused'
  python3 - "$TDSH/silence-receipt.json" "$TDSH/silence-proof.json" "$NATIVE_PROOF" "$SILENT_STREAM" <<'EOF' || fail 'native no-speech path claimed success or lost real error/stream/admission correlation'
import json, sys
receipt, after, before = (json.load(open(p)) for p in sys.argv[1:4])
assert receipt.get('streamId') == sys.argv[4], 'no-speech receipt stream mismatch'
assert receipt.get('ackFinals') == 0 and receipt.get('delivered') is False and receipt.get('drafted', False) is False, 'silence cannot ACK, submit or draft'
assert receipt.get('code', receipt.get('error')) == 'no-speech', 'explicit no-speech code missing'
assert isinstance(receipt.get('message'), str) and receipt['message'], 'actionable no-speech error missing'
assert any(e.get('streamId') == sys.argv[4] and e.get('code') == 'no-speech' for e in after['errors']), 'actual production native no-speech event absent'
cursor = before['snapshot']['cursor']
assert not any(r.get('type') == 'event' and r['event']['seq'] > cursor and r['event']['type'] == 'user/message' for r in after['snapshot']['records']), 'silence created a false durable SDK user prompt'
print('native generated SILENCE PASS: real no-speech callback, stream-matched ack0/deliveredfalse/draftedfalse/error, no SDK prompt; never user microphone')
EOF
  # Third RECORD proves a healthy consenting service is still usable after
  # EOF/no-speech WITHOUT another setup call, synthesis or OS permission ask.
  RECOVERY_STREAM="recovery-$(python3 -c 'import secrets; print(secrets.token_hex(4))')"
  code_recovery=$(auth_curl '/watch/mic/start' "$TDSH/recovery-start.json" -H 'Content-Type: application/json' --data "{\"streamId\":\"$RECOVERY_STREAM\"}") || fail 'third record recovery preflight failed'
  [ "$code_recovery" = 200 ] || fail "third record after no-speech without setup: want 200, got $code_recovery"
  python3 - "$TDSH/recovery-start.json" "$RECOVERY_STREAM" <<'EOF' || fail 'third record recovery did not yield actual ready input'
import json, sys
receipt = json.load(open(sys.argv[1]))
assert receipt.get('streamId') == sys.argv[2] and receipt.get('state') == 'ready', 'actual service must return third input ready, not sticky closed'
print('native repeatability PASS: third RECORD ready after positive EOF and no-speech, no setup/synthesis in between')
EOF
  # Force-abort ONLY this synthetic empty input, never generic model cancel.
  code_mcancel_bad=$(auth_curl '/watch/command' "$TDSH/mic-cancel-invalid.json" -H 'Content-Type: application/json' --data '{"cmd":"mic-cancel","streamId":"../invalid"}') || fail 'malformed scoped cancel probe failed'
  [ "$code_mcancel_bad" = 400 ] || fail "malformed input cancel: want 400, got $code_mcancel_bad"
  for _cancel_pass in first repeated; do
    code_mcancel=$(auth_curl '/watch/command' "$TDSH/mic-cancel-$_cancel_pass.json" -H 'Content-Type: application/json' --data "{\"cmd\":\"mic-cancel\",\"streamId\":\"$RECOVERY_STREAM\"}") || fail 'scoped empty input cancel failed'
    [ "$code_mcancel" = 200 ] || fail "scoped input cancel: want 200, got $code_mcancel"
  done
  python3 - "$TDSH/mic-cancel-first.json" "$TDSH/mic-cancel-repeated.json" "$RECOVERY_STREAM" <<'EOF' || fail 'actual scoped cancel did not resolve once/idempotently'
import json, sys
first, repeated = (json.load(open(p)) for p in sys.argv[1:3])
assert first.get('streamId') == repeated.get('streamId') == sys.argv[3]
assert first.get('cancelled') is True and repeated.get('cancelled') is False
print('native scoped mic-cancel PASS: empty synthetic input disposed once, repeated idempotentfalse; no model cancel')
EOF
  code_reused=$(auth_curl '/watch/mic/start' "$TDSH/mic-retired.json" -H 'Content-Type: application/json' --data "{\"streamId\":\"$RECOVERY_STREAM\"}") || fail 'retired stream replay probe failed'
  [ "$code_reused" = 409 ] || fail "cancelled stream id cannot be reopened: want 409, got $code_reused"
  FOURTH_STREAM="fourth-$(python3 -c 'import secrets; print(secrets.token_hex(4))')"
  code_fourth=$(auth_curl '/watch/mic/start' "$TDSH/fourth-start.json" -H 'Content-Type: application/json' --data "{\"streamId\":\"$FOURTH_STREAM\"}") || fail 'fourth record after scoped cancellation failed'
  [ "$code_fourth" = 200 ] || fail "new record after scoped cancel without setup: want 200, got $code_fourth"
  code_fourth_cancel=$(auth_curl '/watch/command' "$TDSH/fourth-cancel.json" -H 'Content-Type: application/json' --data "{\"cmd\":\"mic-cancel\",\"streamId\":\"$FOURTH_STREAM\"}") || fail 'fourth empty synthetic input disposal failed'
  [ "$code_fourth_cancel" = 200 ] || fail 'fourth empty input cancellation refused'
else
  echo "native delivery leg skipped (gate $NATIVE_GATE; nothing faked, nothing auto-submitted)"
fi
# Secret-free ephemeral diagnostics summary (no token/secret/session text):
# permission diag + 9-claim counters for REPORT-EN.
{
  echo "mode=$MODE require_native=$REQUIRE_NATIVE"
  echo "helper_under_test=${HELP_UNDER_TEST:-none} help_code=${HELP_CODE:-n/a}"
  echo "native_status_exit=${NATIVE_STATUS_CODE:-n/a} gate=$NATIVE_GATE"
  echo "mic_preflight_setup=${code_micstart:-n/a} native_micstart=${code_nmicstart:-n/a}"
  echo "receipt_ackFinals=${ACKS:-0} delivered=${DELIVERED:-0}"
  echo "native_claims_ok=$NATIVE_CLAIMS_OK/9 native_pass=$NATIVE_PASS routing_pass=${ROUTING_PASS:-0}"
  echo "helper_shipped=${HELPER_SHIPPED:-0} script_shipped=${SCRIPT_SHIPPED:-0} replay_drift=${REPLAY_DRIFT:-0}"
} >"$TDSH/diag-summary.txt"
cat "$TDSH/diag-summary.txt"

echo "== phase 9c: device revoke -> token dead, no reconnect (full only) =="
# Revoke runs LAST (it kills the device credential used above). Admin
# revoke is identifier-only; the old token must 401 everywhere after.
REVOKE_JSON="$TDSH/revoke.json"
REVOKE_BODY="$TDSH/revoke-body.json"
python3 - "$REVOKE_BODY" "$DEVICE_ID" <<'EOF' || fail "revoke body build failed"
import json, sys
json.dump({"deviceId": sys.argv[2]}, open(sys.argv[1], "w"))
EOF
code_revoke=$(curl -s -b "$COOKIE_JAR" -o "$REVOKE_JSON" -w '%{http_code}' "${BOUND_URL}admin/pair/revoke" -H 'Content-Type: application/json' --data @"$REVOKE_BODY") || fail "admin revoke failed"
[ "$code_revoke" = "200" ] || fail "admin revoke: want 200, got $code_revoke"
python3 - "$REVOKE_JSON" "$DEVICE_ID" <<'EOF' || fail "revoke shape wrong (see above)"
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("deviceId") == sys.argv[2] and d.get("status") == "revoked", "revoke"
print("revoke ok (identifier-only, no secret echoed)")
EOF
code_dead=$(curl -s --cacert "$TURNKEY_CERT" -o /dev/null -w '%{http_code}' --cacert "$TURNKEY_CERT" -H "X-Bridge-Token: $DTOKEN" "$LAN_BASE/watch/health") || fail "dead-token probe failed"
[ "$code_dead" = "401" ] || fail "revoked token: want 401, got $code_dead"
code_noreconnect=$(curl -s --cacert "$TURNKEY_CERT" -o /dev/null -w '%{http_code}' "$LAN_BASE/pair/poll" -H 'Content-Type: application/json' --data @"$POLL_BODY") || fail "no-reconnect poll failed"
case "$code_noreconnect" in
  401|410) echo "no reconnect after revoke (poll $code_noreconnect; consumed request stays dead)" ;;
  *) fail "post-revoke poll: want 401/410, got $code_noreconnect" ;;
esac
echo "PASS phase 9c (revoke 200 -> old token 401 -> poll stays non-200)"

echo "== phase 10: stop + ports-freed + verdict =="
kill "$BOOT_PID" 2>/dev/null || true
_FREED=0
for _i in $(seq 1 15); do
  if ! kill -0 "$BOOT_PID" 2>/dev/null; then _FREED=1; break; fi
  sleep 1
done
if [ "$_FREED" = "0" ]; then kill -9 "$BOOT_PID" 2>/dev/null || true; fail "own boot PID did not exit (port leak risk)"; fi
if curl -s -o /dev/null --max-time 3 "$BOUND_URL" 2>/dev/null; then fail "web port still answers after stop"; fi
if curl -s --cacert "$TURNKEY_CERT" -o /dev/null --max-time 3 "$LAN_BASE/pair/info" 2>/dev/null; then fail "LAN port still answers after stop"; fi
echo "ports freed (web + LAN refuse after stop); temp files shred with \$TDSH on exit"
echo "=============================="
echo "FULL leg table (all executed, ephemeral only, fixtures labelled):"
echo "  pack-from-source + official-CLI install + manifest reconcile : PASS"
echo "  keyless boot + 401 gates + own-token login                   : PASS"
echo "  admin 401 / foreign-Origin reject / status shape             : PASS"
echo "  pair/info shape + TLS bind-assert + enroll/approval/poll     : PASS"
echo "  replay rejection (single-issuance holds${REPLAY_DRIFT:+; code-label drift 410-vs-401 logged}) : PASS"
echo "  deny path                                                    : PASS"
echo "  device health/binding/capabilities/command/SSE               : PASS"
echo "  fixture route gate 401 + HOST_LLM routing                    : ${ROUTING_PASS:+PASS (user record + assistant echo, real session ${FIXTURE_SESSION:-?})}"
echo "  binding targets real session + cappi wrong-409/bound-200     : PASS"
echo "  Settings UI asset (no browser)                               : PASS"
echo "  mic preflight fail-closed ($code_micstart)                    : PASS (asserted, not bypassed)"
echo "  revoke 200 -> old token 401 -> no reconnect                  : PASS"
if [ "${NATIVE_PASS:-0}" = "1" ] && [ "${DELIVERED:-0}" = "1" ]; then
  echo "  PCM upload -> ASR final -> host admission (ACK)              : PASS (ackFinals=$ACKS, generated speech, never sine)"
  echo "  native gate (packed --status authorized, no new prompt)      : PASS"
  echo "  voice setup {consent:true} -> ready (user-safe)              : PASS"
  echo "  bound-session mic/start 200 (fixture session)                : PASS"
  echo "  follow assistant/running + prod TTS started/audio/done       : PASS (live SSE, 9/9 claims)"
  echo "  replay dedupe / counters / source API (no _routing fake)     : PASS"
  if [ "${HELPER_BLOCKED:-0}" = "1" ]; then
    echo "  helper installability                                       : BLOCKED (V packaging next-fix, see above)"
    echo "ROUTING_PASS (exit 3): routing + native delivery live, installability blocked."
    exit 3
  fi
  node22_acceptance || exit $?
  echo "FULL PASS (actual runtime $RUNTIME_VERSION; real wire incl native ASR + production TTS; Node22 matrix=$NODE22_STATE)"
  echo "REPORT-EN: native 9/9 (status authorized, setup ready, mic 200, ackFinals=$ACKS, follow+TTS live); routing PASS (fixture session ${FIXTURE_SESSION:-?}); ports freed; no secrets logged."
  exit 0
else
  echo "  PCM->ASR->host admission                                    : PENDING/BLOCKED (gate=$NATIVE_GATE, preflight=$code_micstart, no faked ACK)"
  if [ "${HELPER_BLOCKED:-0}" = "1" ]; then
    echo "  helper installability                                       : BLOCKED (V packaging next-fix, see above)"
  else
    echo "  native helper static truth + toolchain                      : PASS (see phase 9)"
  fi
  echo "  OS speech recognition                                       : $NATIVE_GATE (packed --status gate; needs user TCC grant when not authorized; never auto-prompted)"
  echo "  HOST_LLM routing                                            : PASS (fixture adapter, see phase 7c — fake-ASR routing only, never a native claim)"
  if [ "$REQUIRE_NATIVE" = "1" ]; then
    echo "FAIL (exit 1): --require-native set and a native leg is pending/blocked (gate=$NATIVE_GATE, preflight=$code_micstart). Conservative fail, no READY claim."
    exit 1
  fi
  echo "ROUTING_PASS (exit 3): HOST_LLM routing proven end-to-end on real"
  echo "sessionController prompt/page/follow; delivery/assistant-native/"
  echo "recognition need live user state (provider key or fixture adapter is"
  echo "in place; OS TCC + ready ASR still pending). No false PASS emitted."
  echo "REPORT-EN: gate=$NATIVE_GATE claims=$NATIVE_CLAIMS_OK/9 routing PASS (fixture session ${FIXTURE_SESSION:-?}); exact block above (H/V/harness labelled, never blank PENDING); diag counts secret-free in temp diag-summary.txt (see --keep-tmp); ports freed."
  exit 3
fi
