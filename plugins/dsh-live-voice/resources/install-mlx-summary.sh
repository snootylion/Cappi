#!/usr/bin/env bash
# install-mlx-summary.sh — provision the local MLX summary/holding model runtime.
#
# Safety: dry-run by default. `--apply` + `--download-models` (explicit
# opt-in) performs the install into a configurable root. Refuses live targets
# without `--allow-live` + `DSH_WATCH_MAINTENANCE_CONFIRM=1`.
#
# License note: the model asset is a third-party artifact fetched at a pinned
# revision (defaults: cof139/G9v3-3B-mlx-4Bit). Downloading it implies
# acceptance of its upstream terms; no weights are vendored here.
set -euo pipefail

SCRIPT_NAME="install-mlx-summary.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=install-common.sh
source "$SCRIPT_DIR/install-common.sh"

usage() {
  printf 'Usage: %s [--apply] [--download-models] [common options]\n' "$0"
  common_usage_tail
  printf '  --download-models  Permit network download of the pinned model asset (explicit opt-in).\n'
}

DOWNLOAD_MODELS=0

parse_common_args "$@"
common_status=$?
if [[ $common_status -eq 3 ]]; then usage; exit 0; fi
if [[ $common_status -ne 0 ]]; then usage >&2; exit 2; fi
shift "$CONSUMED_ARGC" 2>/dev/null || true

while (($# > 0)); do
  case "$1" in
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

MODEL_REPO=${DSH_KOKORO_SUMMARY_MODEL_REPO:-cof139/G9v3-3B-mlx-4Bit}
MODEL_REVISION=${DSH_KOKORO_SUMMARY_MODEL_REVISION:-076ed58eed5a29dc7a27cf16d184db59550f09cb}
ROOT=${RUNTIME_ROOT_OVERRIDE:-${DSH_KOKORO_SUMMARY_ROOT:-"$HOME/Library/Application Support/DeepSeek Harness/live-voice-kokoro/summary"}}
MODEL_PATH=${DSH_KOKORO_SUMMARY_MODEL_PATH:-"$ROOT/model"}
PYTHON=${DSH_KOKORO_BOOTSTRAP_PYTHON:-${DSH_LIVE_VOICE_BOOTSTRAP_PYTHON:-/opt/homebrew/bin/python3.12}}

# Live-target refusal happens on the mutating path only (after dry-run).
if [[ "$DRY_RUN" == "1" ]]; then
  log_plan "runtime root: $ROOT"
  log_plan "model path: $MODEL_PATH"
  log_plan "bootstrap python: $PYTHON"
  if [[ "$DOWNLOAD_MODELS" == "1" ]]; then
    log_plan "model: download ${MODEL_REPO}@${MODEL_REVISION} (explicit opt-in)"
  else
    log_plan "model: SKIPPED (needs --download-models)"
  fi
  log_plan "venv: $ROOT/.venv + mlx-summary-requirements.lock (hash-pinned)"
  finish_if_dry_run
  exit 0
fi

if [[ "$DOWNLOAD_MODELS" != "1" ]]; then
  printf '%s: refusing to download %s@%s without --download-models.\n' "$SCRIPT_NAME" "$MODEL_REPO" "$MODEL_REVISION" >&2
  printf '%s: model assets are third-party downloads (see docs/plugins.md for revision and license notes).\n' "$SCRIPT_NAME" >&2
  exit 2
fi

refuse_live_target "$ROOT" "mlx summary runtime root" || exit 1

[[ "$(uname -s)" == "Darwin" ]] || { printf 'This installer requires macOS (Apple-silicon MLX runtime).\n' >&2; exit 1; }
[[ -x "$PYTHON" ]] || { printf 'Bootstrap Python was not found at %s\n' "$PYTHON" >&2; exit 1; }

mkdir -p "$ROOT"
if [ ! -x "$ROOT/.venv/bin/python" ]; then
  "$PYTHON" -m venv "$ROOT/.venv"
fi
"$ROOT/.venv/bin/python" -m pip install --disable-pip-version-check --require-hashes -r "$SCRIPT_DIR/mlx-summary-requirements.lock"
MODEL_PATH="$MODEL_PATH" MODEL_REPO="$MODEL_REPO" MODEL_REVISION="$MODEL_REVISION" "$ROOT/.venv/bin/python" - <<'PY'
import os
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id=os.environ["MODEL_REPO"],
    revision=os.environ["MODEL_REVISION"],
    local_dir=os.environ["MODEL_PATH"],
)
PY
printf 'Installed %s at revision %s in %s\n' "$MODEL_REPO" "$MODEL_REVISION" "$MODEL_PATH"
