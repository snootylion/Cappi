#!/usr/bin/env bash
# install-shared-desktop-launcher.sh — rebuild the floating Live Voice panel
# launcher inside a desktop Harness app bundle from this tree's Swift source.
#
# Safety: dry-run by default (verifies sources, prints the plan, changes
# nothing). `--apply` compiles and installs; modifying an existing installed
# app bundle additionally requires `--allow-live` +
# `DSH_WATCH_MAINTENANCE_CONFIRM=1`. `--app-path` selects the bundle
# (default: the per-user shared app); nothing targets another user's install.
set -euo pipefail

SCRIPT_NAME="install-shared-desktop-launcher.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=install-common.sh
source "$SCRIPT_DIR/install-common.sh"

usage() {
  printf 'Usage: %s [--apply] [--app-path /path/to/Shared.app]\n' "$0"
  common_usage_tail
  printf '  --app-path PATH    Desktop app bundle to update (default: ~/Applications/DeepSeek Harness Shared.app).\n'
}

APP_OVERRIDE=""

parse_common_args "$@"
common_status=$?
if [[ $common_status -eq 3 ]]; then usage; exit 0; fi
if [[ $common_status -ne 0 ]]; then usage >&2; exit 2; fi
shift "$CONSUMED_ARGC" 2>/dev/null || true

while (($# > 0)); do
  case "$1" in
    --app-path)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      APP_OVERRIDE="$2"
      shift 2
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

SOURCE="$SCRIPT_DIR/dsh-shared-launcher.swift"
APP="${APP_OVERRIDE:-${DSH_SHARED_APP_PATH:-$HOME/Applications/DeepSeek Harness Shared.app}}"
CONTENTS="$APP/Contents"
BINARY="$CONTENTS/MacOS/dsh-shared"
INSTALLED_SOURCE="$CONTENTS/Resources/Launcher.swift"

[[ -f "$SOURCE" ]] || { printf 'Missing launcher source: %s\n' "$SOURCE" >&2; exit 1; }

if [[ "$DRY_RUN" == "1" ]]; then
  log_plan "launcher source: $SOURCE"
  log_plan "target bundle: $APP"
  log_plan "steps: swiftc (AppKit/Network/WebKit) -> install binary + source copy -> ad-hoc codesign"
  if [[ -f "$CONTENTS/Info.plist" ]]; then
    log_plan "note: bundle exists; --apply also needs --allow-live + DSH_WATCH_MAINTENANCE_CONFIRM=1"
  else
    log_plan "note: bundle is missing; --apply will refuse until the desktop app is installed"
  fi
  finish_if_dry_run
  exit 0
fi

[[ -f "$CONTENTS/Info.plist" ]] || { printf 'Shared Harness app not found: %s\n' "$APP" >&2; exit 1; }
# An existing installed bundle is live user state: require maintenance confirm.
if [[ "$ALLOW_LIVE" != "1" || "${DSH_WATCH_MAINTENANCE_CONFIRM:-0}" != "1" ]]; then
  printf '%s: refusing to modify installed bundle %s without --allow-live and DSH_WATCH_MAINTENANCE_CONFIRM=1\n' "$SCRIPT_NAME" "$APP" >&2
  exit 1
fi

TMP_BINARY="$(mktemp "${TMPDIR:-/tmp}/dsh-shared.XXXXXX")"
trap 'rm -f "$TMP_BINARY"' EXIT

xcrun swiftc -O -framework AppKit -framework Network -framework WebKit "$SOURCE" -o "$TMP_BINARY"
install -m 0755 "$TMP_BINARY" "$BINARY"
install -m 0644 "$SOURCE" "$INSTALLED_SOURCE"
codesign --force --deep --sign - "$APP" >/dev/null

echo "Installed floating Live Voice panel launcher at $APP"
echo "Quit and reopen the desktop Harness app to load it."
