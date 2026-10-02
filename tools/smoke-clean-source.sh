#!/bin/sh
# tools/smoke-clean-source.sh — clean-source smoke for a local candidate.
#
# Extracts a LOCAL source archive into a fresh temp dir and re-runs the
# safe checks THERE (not in this working tree):
#   1. secret/PII/path scan of the extracted tree
#   2. asset validation + shipped-binary metadata on the extracted tree
#   3. tools/ Python test suite from the extracted tree
#   4. bridge Node tests from the extracted tree (loopback/ephemeral only)
#   5. bridge-only installer plan-mode dry-runs with an isolated HOME
#   6. archive-member scan of the source archive itself
#   7. no-link proof: the extract holds no symlink/absolute reference back
#      to this working tree or to any install location
#
# Default: no Gradle/Android builds or dependency installation/network.
# --plugins explicitly adds published frozen SDK installs, exported-source
# native compilation on macOS, then both plugin TS/build/test suites. This
# build-only --apply never installs/deploys, asks TCC, or captures audio.
# --keep-tmp retains private extracted roots for subsequent acceptance.
#
# Safety: read-only w.r.t. this tree; writes only dist/ (when it must build
# an archive) and temp dirs. Ambient DSH_*/BRIDGE_* variables are scrubbed
# for every nested step so operator-shell fixtures can never redirect a
# test. Installers are NEVER run with --apply and NEVER against the real
# HOME (isolated temp HOME + residue check). No network, no live DSH, no
# harness restart, no credentials.
#
# Usage:
#   ./tools/smoke-clean-source.sh [--local-tar dist/...-source.tar.gz]
#   ./tools/smoke-clean-source.sh --help
# Without --local-tar a fresh export is built via tools/export-source.sh
# into dist/ (gitignored) and used as the smoke input.
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
ARCHIVE=""
PLUGINS=0
KEEP_TMP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --local-tar) ARCHIVE="${2:-}"; shift 2 ;;
    --local-tar=*) ARCHIVE="${1#--local-tar=}"; shift ;;
    --plugins) PLUGINS=1; shift ;;
    --keep-tmp) KEEP_TMP=1; shift ;;
    -h|--help)
      echo "usage: $0 [--local-tar dist/<name>-source.tar.gz] [--plugins] [--keep-tmp]" >&2
      exit 0 ;;
    --*) echo "unknown arg: $1" >&2; exit 2 ;;
    *)
      # positional form: ./tools/smoke-clean-source.sh dist/foo.tar.gz
      if [ -z "$ARCHIVE" ]; then ARCHIVE="$1"; shift; else
        echo "unknown arg: $1" >&2; exit 2
      fi ;;
  esac
done
if [ "$ARCHIVE" = "--local-tar" ] || [ -z "${ARCHIVE:-}" ]; then
  : # empty means "build a fresh export below"; literal flag alone is refused
  if [ "$ARCHIVE" = "--local-tar" ]; then
    echo "smoke REFUSED: --local-tar needs a value" >&2; exit 2
  fi
fi

# Scrub ambient harness variables for everything below. Explicit per-test
# values still win inside the suites; the operator shell never leaks in.
for v in $(env | cut -d= -f1 | grep -E '^(DSH_|BRIDGE_|VOICE_|LIVE_VOICE_|KOKORO_|POCKET_|NPM_CONFIG_|npm_config_|XDG_)' || true); do
  unset "$v" || true
done
# Isolated HOME for the whole smoke (installers + bridge storage paths).
SMOKE_HOME=$(mktemp -d "${TMPDIR:-/tmp}/wear-dsh-smoke-home.XXXXXX")
SMOKE_HOME=$(CDPATH= cd -- "$SMOKE_HOME" && pwd -P)
chmod 700 "$SMOKE_HOME"
export HOME="$SMOKE_HOME"
export DSH_HOME="$SMOKE_HOME/.dsh"
export BRIDGE_STATE_DIR="$SMOKE_HOME/.local/state/dsh-watch-bridge"
export XDG_STATE_HOME="$SMOKE_HOME/.local/state"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/wear-dsh-smoke-src.XXXXXX")
WORK=$(CDPATH= cd -- "$WORK" && pwd -P)
chmod 700 "$WORK"
trap '[ "$KEEP_TMP" = 1 ] || rm -rf "$WORK" "$SMOKE_HOME"' EXIT INT TERM

BUILT_TMP=""
if [ -z "$ARCHIVE" ]; then
  ARCHIVE="dist/.smoke-source.tar.gz"
  echo "== building smoke input via export-source.sh -> $ARCHIVE =="
  SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}" \
    "$ROOT/tools/export-source.sh" --out "$ARCHIVE"
  BUILT_TMP="$ROOT/$ARCHIVE"
fi
case "$ARCHIVE" in
  /*) ARCH_ABS="$ARCHIVE" ;;
  *) ARCH_ABS="$ROOT/$ARCHIVE" ;;
esac
[ -f "$ARCH_ABS" ] || { echo "smoke REFUSED: no such archive: $ARCHIVE" >&2; exit 2; }

echo "== smoke input: $ARCH_ABS =="
echo "== extracting to fresh temp dir: $WORK =="
tar -xzf "$ARCH_ABS" -C "$WORK"
echo "extracted: $(find "$WORK" -type f | wc -l | tr -d ' ') files"

FAIL=0
run() {
  label="$1"; shift
  if "$@" ; then echo "ok: $label";
  else echo "FAIL: $label" >&2; FAIL=1; fi
}

echo "== 1/7 source-tree scan on EXTRACTED tree (paths+counts only) =="
run "extract-scan" python3 "$WORK/tools/scan-secrets.py" --root "$WORK"

echo "== 2/7 asset + binary checks on EXTRACTED tree =="
run "extract-assets" python3 "$WORK/tools/validate-assets.py" --root "$WORK"
run "extract-binaries" python3 "$WORK/tools/inspect-binaries.py" --root "$WORK"

echo "== 3/7 tools test suite FROM extracted source =="
run "extract-tools-tests" python3 -m unittest discover -s "$WORK/tools/tests" -t "$WORK/tools" -v

echo "== 4/7 bridge tests FROM extracted source (loopback/ephemeral only) =="
# No DSH_/BRIDGE_ in env (scrubbed above); HOME is the isolated temp dir.
if command -v node >/dev/null 2>&1; then
  run "extract-bridge-tests" sh -c 'cd "$1/bridge" && node --test *.test.mjs' sh "$WORK"
else
  echo "SKIP: node not installed; bridge checks run in CI (.github/workflows/ci.yml)" >&2
fi

echo "== 5/7 bridge-only installer plan-mode on EXTRACTED tree (isolated HOME) =="
run "extract-installer-dryrun" sh "$WORK/tools/installer-dryrun.sh" --bridge-only

echo "== 6/7 archive-member scan of the ACTUAL artifact =="
run "archive-scan" python3 "$ROOT/tools/scan-secrets.py" --archive "$ARCH_ABS"

echo "== 7/7 no-link proof (extract must not reference this tree/install) =="
LINKS_BAD=0
# 7a. No symlink inside the extract may resolve into this working tree.
if find "$WORK" -type l | grep -q .; then
  echo "symlinks present in extract (listing targets):" >&2
  find "$WORK" -type l -exec ls -l {} \; >&2
  # Resolve each link; any target under ROOT fails the smoke.
  find "$WORK" -type l | while IFS= read -r link; do
    target=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$link")
    case "$target" in
      "$ROOT"/*) echo "FAIL: link $link -> $target (inside working tree)" >&2; exit 1 ;;
    esac
  done || LINKS_BAD=1
else
  echo "ok: no symlinks in extracted tree"
fi
# 7b. No extracted text file may contain this checkout's absolute path.
if grep -r -F -- "$ROOT" "$WORK" >/dev/null 2>&1; then
  echo "FAIL: extracted tree references working-tree path $ROOT:" >&2
  grep -r -F -l -- "$ROOT" "$WORK" >&2 || true
  LINKS_BAD=1
else
  echo "ok: no absolute working-tree path inside extracted tree"
fi
# 7c. No extracted text file may contain the smoke HOME (would pin one machine).
if grep -r -F -- "$SMOKE_HOME" "$WORK" >/dev/null 2>&1; then
  echo "FAIL: extracted tree references smoke HOME" >&2; LINKS_BAD=1
else
  echo "ok: no smoke-HOME path inside extracted tree"
fi
[ "$LINKS_BAD" = 0 ] || FAIL=1

echo "== isolated HOME residue check =="
if [ -n "$(find "$SMOKE_HOME" -mindepth 1 -maxdepth 3 2>/dev/null | head -n 5)" ]; then
  echo "FAIL: smoke wrote into isolated HOME:" >&2
  find "$SMOKE_HOME" -mindepth 1 -maxdepth 3 >&2
  FAIL=1
else
  echo "ok: isolated HOME untouched (no installs, no --apply)"
fi

if [ "$PLUGINS" = 1 ]; then
  echo '== opt-in clean plugin SDK install/build/test (published frozen rc.1; private caches) =='
  export NPM_CONFIG_USERCONFIG="$SMOKE_HOME/blank-npmrc"
  export NPM_CONFIG_GLOBALCONFIG=/dev/null
  export NPM_CONFIG_CACHE="$SMOKE_HOME/npm-cache"
  export NPM_CONFIG_REGISTRY=https://registry.npmjs.org
  export XDG_CONFIG_HOME="$SMOKE_HOME/.config"
  : > "$NPM_CONFIG_USERCONFIG"
  node --version
  for plugin in dsh-watch dsh-live-voice; do
    run "fresh-$plugin-frozen-install" sh -c 'cd "$1" && npx --yes pnpm@10.15.1 install --frozen-lockfile' sh "$WORK/plugins/$plugin"
  done
  # Compile from EXPORTED Swift/plist, never copy working-tree native bytes.
  # --apply authorizes source build only, not installation, TCC or capture.
  run 'fresh-export-native-build' bash "$WORK/plugins/dsh-live-voice/scripts/build-watch-helpers.sh" --apply
  run 'fresh-dsh-watch-check' sh -c 'cd "$1" && npx --yes pnpm@10.15.1 run check' sh "$WORK/plugins/dsh-watch"
  # Equivalent to V's declared check script, with original assertions/timeouts.
  # Its installer rollback tests perform synchronous filesystem processes and
  # approach Vitest's 5s budget; parallel files contend on macOS. Serialize ALL
  # files (no filters/skips), not a retry or relaxed deadline. Source unchanged.
  run 'fresh-dsh-live-voice-typecheck-server-client' sh -c 'cd "$1" && npx --yes pnpm@10.15.1 run typecheck' sh "$WORK/plugins/dsh-live-voice"
  run 'fresh-dsh-live-voice-build' sh -c 'cd "$1" && npx --yes pnpm@10.15.1 run build' sh "$WORK/plugins/dsh-live-voice"
  run 'fresh-dsh-live-voice-all-tests-sequential' sh -c 'cd "$1" && npx --yes pnpm@10.15.1 exec vitest run --maxWorkers=1 --fileParallelism=false' sh "$WORK/plugins/dsh-live-voice"
  echo 'fresh checks use isolated HOME/cache only; no global installation/live DSH/model keys'
fi

[ "$KEEP_TMP" != 1 ] || echo "PRIVATE inspection roots retained: $WORK and $SMOKE_HOME"
echo "=============================="
if [ "$FAIL" = 0 ]; then
  echo "SMOKE PASS (extracted source; full frozen plugin/native builds requested=$PLUGINS; no Android build, live profile or physical-watch claim)"
else
  echo "SMOKE FAIL" >&2
fi
# Remove the auto-built input so dist/ holds only deliberate candidates.
if [ -n "$BUILT_TMP" ]; then rm -f "$BUILT_TMP" "$BUILT_TMP.sha256"; fi
exit "$FAIL"
