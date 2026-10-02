#!/usr/bin/env bash
# install-live-voice-runtime.sh — provision the self-contained live-voice
# runtime (Apple Speech helper, Kokoro TTS venv+model, Pocket TTS venv).
#
# Safety: dry-run by default (prints the plan, changes nothing). `--apply`
# performs the install into a configurable runtime root. Model downloads only
# happen with explicit `--download-models` opt-in; the pinned revisions and
# hash manifest are verified whenever models are staged. Refuses to target a
# live root without `--allow-live` + `DSH_WATCH_MAINTENANCE_CONFIRM=1`.
#
# License note: model assets are third-party artifacts fetched from their
# upstream repos at pinned revisions (see docs/plugins.md). Downloading them
# implies acceptance of their upstream terms; no weights are vendored here.
set -euo pipefail

SCRIPT_NAME="install-live-voice-runtime.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=install-common.sh
source "$SCRIPT_DIR/install-common.sh"

usage() {
  printf 'Usage: %s [--apply] [--model-source /absolute/model/path] [--download-models] [common options]\n' "$0"
  common_usage_tail
  printf '  --download-models  Permit network download of pinned model assets (explicit opt-in).\n'
}

DOWNLOAD_MODELS=0
MODEL_SOURCE=""

parse_common_args "$@"
common_status=$?
if [[ $common_status -eq 3 ]]; then usage; exit 0; fi
if [[ $common_status -ne 0 ]]; then usage >&2; exit 2; fi
shift "$CONSUMED_ARGC" 2>/dev/null || true

while (($# > 0)); do
  case "$1" in
    --model-source)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      MODEL_SOURCE="$2"
      shift 2
      ;;
    --download-models)
      DOWNLOAD_MODELS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

LIVE_ROOT="${RUNTIME_ROOT_OVERRIDE:-${DSH_LIVE_VOICE_ROOT:-$HOME/Library/Application Support/DeepSeek Harness/live-voice-kokoro}}"
BOOTSTRAP_PYTHON="${DSH_LIVE_VOICE_BOOTSTRAP_PYTHON:-${DSH_KOKORO_BOOTSTRAP_PYTHON:-/opt/homebrew/bin/python3.12}}"
MODEL_REPO="${DSH_KOKORO_MODEL_REPO:-mlx-community/Kokoro-82M-bf16}"
MODEL_REVISION="${DSH_KOKORO_MODEL_REVISION:-a71e4d38b236d968966a2002c4c895dbd12b1c3c}"
POCKET_TTS_VERSION="${DSH_POCKET_TTS_VERSION:-3.0.2}"

if [[ -n "$MODEL_SOURCE" && ! -d "$MODEL_SOURCE" ]]; then
  printf 'Model source does not exist: %s\n' "$MODEL_SOURCE" >&2
  exit 1
fi

# Live-target refusal happens on the mutating path only (after dry-run).
if [[ "$DRY_RUN" == "1" ]]; then
  log_plan "runtime root: $LIVE_ROOT"
  log_plan "bootstrap python: $BOOTSTRAP_PYTHON"
  if [[ -n "$MODEL_SOURCE" ]]; then
    log_plan "kokoro model: offline copy from $MODEL_SOURCE (no download)"
  elif [[ "$DOWNLOAD_MODELS" == "1" ]]; then
    log_plan "kokoro model: download ${MODEL_REPO}@${MODEL_REVISION} (explicit opt-in)"
  else
    log_plan "kokoro model: SKIPPED (needs --download-models or --model-source)"
  fi
  log_plan "pocket TTS: venv + pocket-tts==${POCKET_TTS_VERSION} (opt-in install, no cloning weights)"
  log_plan "helper: compile dsh-live-voice-input-helper.swift (macOS, Xcode tools)"
  log_plan "verify: pinned hashes (kokoro-model-sha256.txt), symlink refusal, staged atomic swap"
  finish_if_dry_run
  exit 0
fi

if [[ -z "$MODEL_SOURCE" && "$DOWNLOAD_MODELS" != "1" ]]; then
  printf '%s: refusing to download %s@%s without --download-models.\n' "$SCRIPT_NAME" "$MODEL_REPO" "$MODEL_REVISION" >&2
  printf '%s: model assets are third-party downloads (see docs/plugins.md for revisions, checksums, license notes).\n' "$SCRIPT_NAME" >&2
  printf '%s: re-run with --download-models to opt in, or pass --model-source for an offline copy.\n' "$SCRIPT_NAME" >&2
  exit 2
fi

refuse_live_target "$LIVE_ROOT" "live-voice runtime root" || exit 1

[[ "$(uname -s)" == "Darwin" ]] || { printf 'This installer requires macOS.\n' >&2; exit 1; }
command -v xcrun >/dev/null || { printf 'xcrun is required. Install Apple command-line tools.\n' >&2; exit 1; }
command -v codesign >/dev/null || { printf 'codesign is required.\n' >&2; exit 1; }
[[ -x "$BOOTSTRAP_PYTHON" ]] || { printf 'Bootstrap Python was not found at %s (override with DSH_LIVE_VOICE_BOOTSTRAP_PYTHON or --runtime-root layout)\n' "$BOOTSTRAP_PYTHON" >&2; exit 1; }
"$BOOTSTRAP_PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)' || {
  printf 'Python 3.12 is required: %s\n' "$BOOTSTRAP_PYTHON" >&2
  exit 1
}

mkdir -p "$LIVE_ROOT"
STAGE="$(mktemp -d "$LIVE_ROOT/.runtime-stage.XXXXXX")"
BACKUP="$(mktemp -d "$LIVE_ROOT/.runtime-backup.XXXXXX")"
SWAP_STARTED=0
COMMITTED=0

cleanup() {
  local status=$?
  if ((SWAP_STARTED == 1 && COMMITTED == 0)); then
    for component in bin kokoro pocket-tts; do
      rm -rf "$LIVE_ROOT/$component"
      if [[ -e "$BACKUP/$component" ]]; then
        mv "$BACKUP/$component" "$LIVE_ROOT/$component"
      fi
    done
  fi
  rm -rf "$STAGE" "$BACKUP"
  exit "$status"
}
trap cleanup EXIT INT TERM

HELPER_SOURCE="$SCRIPT_DIR/dsh-live-voice-input-helper.swift"
HELPER_PLIST="$SCRIPT_DIR/dsh-live-voice-input-helper-Info.plist"
REQUIREMENTS_LOCK="$SCRIPT_DIR/kokoro-tts-requirements.lock"
MODEL_HASHES="$SCRIPT_DIR/kokoro-model-sha256.txt"
mkdir -p "$STAGE/bin" "$STAGE/kokoro" "$STAGE/pocket-tts"
plutil -lint "$HELPER_PLIST" >/dev/null
xcrun swiftc "$HELPER_SOURCE" -O \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$HELPER_PLIST" \
  -o "$STAGE/bin/dsh-live-voice-input-helper"
codesign --force --sign - --identifier ai.deepseek.dsh.live-voice-input "$STAGE/bin/dsh-live-voice-input-helper"
chmod 755 "$STAGE/bin/dsh-live-voice-input-helper"

"$BOOTSTRAP_PYTHON" -m venv "$STAGE/kokoro/.venv"
VENV_PYTHON="$STAGE/kokoro/.venv/bin/python"
"$VENV_PYTHON" -m pip install --disable-pip-version-check --require-hashes --requirement "$REQUIREMENTS_LOCK"

MODEL_PATH="$STAGE/kokoro/model"
if [[ -n "$MODEL_SOURCE" ]]; then
  if [[ -n "$(find "$MODEL_SOURCE" -type l -print -quit)" ]]; then
    printf 'Refusing to copy a model source containing symbolic links.\n' >&2
    exit 1
  fi
  mkdir -p "$MODEL_PATH"
  rsync -a --delete "$MODEL_SOURCE/" "$MODEL_PATH/"
else
  DSH_KOKORO_INSTALL_MODEL_PATH="$MODEL_PATH" \
  DSH_KOKORO_INSTALL_MODEL_REPO="$MODEL_REPO" \
  DSH_KOKORO_INSTALL_MODEL_REVISION="$MODEL_REVISION" \
  "$VENV_PYTHON" - <<'PY'
import os
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id=os.environ["DSH_KOKORO_INSTALL_MODEL_REPO"],
    revision=os.environ["DSH_KOKORO_INSTALL_MODEL_REVISION"],
    local_dir=os.environ["DSH_KOKORO_INSTALL_MODEL_PATH"],
)
PY
fi

for required in \
  "$MODEL_PATH/config.json" \
  "$MODEL_PATH/kokoro-v1_0.safetensors" \
  "$MODEL_PATH/voices/af_heart.safetensors"; do
  [[ -f "$required" ]] || { printf 'Required Kokoro model file is missing: %s\n' "$required" >&2; exit 1; }
done
[[ -z "$(find "$MODEL_PATH" -type l -print -quit)" ]] || { printf 'The staged model contains symbolic links.\n' >&2; exit 1; }
(cd "$MODEL_PATH" && shasum -a 256 -c "$MODEL_HASHES")
"$VENV_PYTHON" -c 'import kokoro_mlx, mlx, numpy; print("kokoro-runtime-ready")'

POCKET_ROOT="$STAGE/pocket-tts"
"$BOOTSTRAP_PYTHON" -m venv "$POCKET_ROOT/.venv"
POCKET_PYTHON="$POCKET_ROOT/.venv/bin/python"
"$POCKET_PYTHON" -m pip install --disable-pip-version-check --only-binary=:all: "pocket-tts==$POCKET_TTS_VERSION"
HF_HOME="$POCKET_ROOT/hf-home" HUGGINGFACE_HUB_CACHE="$POCKET_ROOT/hf-home/hub" \
"$POCKET_PYTHON" - <<'PY'
from pocket_tts import TTSModel
model = TTSModel.load_model(language="english")
model.get_state_for_audio_prompt("alba")
assert model.sample_rate == 24_000
print("pocket-tts-runtime-ready")
PY
codesign --verify --strict "$STAGE/bin/dsh-live-voice-input-helper"

SWAP_STARTED=1
for component in bin kokoro pocket-tts; do
  if [[ -e "$LIVE_ROOT/$component" ]]; then
    mv "$LIVE_ROOT/$component" "$BACKUP/$component"
  fi
  mv "$STAGE/$component" "$LIVE_ROOT/$component"
done
COMMITTED=1
printf 'Installed self-contained DSH Live Voice runtime at %s\n' "$LIVE_ROOT"
