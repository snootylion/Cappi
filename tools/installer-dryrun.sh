#!/bin/sh
# tools/installer-dryrun.sh — exercise every installer in plan-only mode
# under an isolated temp HOME.
#
# Nothing is installed, no harness is restarted, no live target is touched:
#   - bridge/setup-cert.sh --dry-run, bridge/service.sh install --dry-run
#     (bridge-owned; always run)
#   - plugins/*/resources/install-*.sh and deploy-profile-plugin.sh run
#     WITHOUT --apply (plan mode is their default)
#     unless --bridge-only is given.
#   - HOME, DSH_HOME, BRIDGE_STATE_DIR and XDG_STATE_HOME point into a fresh
#     temp dir; unexported afterwards. Asserts the temp dir is empty of
#     installs afterwards (only dry-run residue allowed: none).
#
# Usage: ./tools/installer-dryrun.sh [--bridge-only]
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BRIDGE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --bridge-only) BRIDGE_ONLY=1 ;;
    -h|--help) echo "usage: $0 [--bridge-only]" >&2; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Portable template (BSD + GNU mktemp): -t without XXXXXX fails on GNU.
TMP_HOME=$(mktemp -d "${TMPDIR:-/tmp}/wear-dsh-dryrun.XXXXXX")
trap 'rm -rf "$TMP_HOME"' EXIT INT TERM
export HOME="$TMP_HOME"
export DSH_HOME="$TMP_HOME/.dsh"
export BRIDGE_STATE_DIR="$TMP_HOME/.local/state/dsh-watch-bridge"
export XDG_STATE_HOME="$TMP_HOME/.local/state"
echo "isolated HOME=$TMP_HOME"

echo "== bridge/setup-cert.sh --dry-run =="
sh "$ROOT/bridge/setup-cert.sh" --dry-run
echo "== bridge/service.sh install --dry-run =="
sh "$ROOT/bridge/service.sh" install --dry-run | head -n 20

if [ "$BRIDGE_ONLY" = 0 ]; then
  for script in "$ROOT"/plugins/*/resources/install-*.sh \
               "$ROOT"/plugins/*/resources/deploy-profile-plugin.sh; do
    [ -f "$script" ] || continue
    echo "== plan mode: $script =="
    # Plan mode is the default (no --apply): prints the plan, changes nothing.
    sh "$script" < /dev/null > /dev/null 2>&1 \
      && echo "  plan exited 0" \
      || echo "  plan exited $? (non-apply failures are reported, not fatal here)"
  done
fi

echo "== temp HOME residue check =="
if [ -n "$(find "$TMP_HOME" -mindepth 1 -maxdepth 3 2>/dev/null | head -n 5)" ]; then
  echo "FAIL: installer wrote into isolated HOME:" >&2
  find "$TMP_HOME" -mindepth 1 -maxdepth 3 >&2
  exit 1
fi
echo "PASS: dry-runs printed plans, isolated HOME untouched."
