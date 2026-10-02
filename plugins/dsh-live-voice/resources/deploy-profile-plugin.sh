#!/usr/bin/env bash
# deploy-profile-plugin.sh — stage this tree's live-voice plugin snapshot and
# link it into a DSH profile (`link:plugins/dsh-live-voice-kokoro`).
#
# Safety: dry-run by default (runs checks, prints the plan, changes nothing).
# `--apply` performs the staged atomic swap. Deploying into an EXISTING
# profile directory additionally requires `--allow-live` +
# `DSH_WATCH_MAINTENANCE_CONFIRM=1`; a fresh isolated DSH_HOME (tests, review)
# needs no live confirmation. The DSH executable is resolved portably
# (`command -v dsh`, overridable with `DSH_DEPLOY_DSH_BIN`); no absolute
# install paths are embedded. Nothing in this tree is ever deployed to a
# live profile by automation.
set -euo pipefail

SCRIPT_NAME="deploy-profile-plugin.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=install-common.sh
source "$SCRIPT_DIR/install-common.sh"

usage() {
  printf 'Usage: %s [--apply] [common options]\n' "$0"
  common_usage_tail
}

parse_common_args "$@"
common_status=$?
if [[ $common_status -eq 3 ]]; then usage; exit 0; fi
if [[ $common_status -ne 0 ]]; then usage >&2; exit 2; fi
shift "$CONSUMED_ARGC" 2>/dev/null || true

while (($# > 0)); do
  case "$1" in
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

PACKAGE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
# DSH_HOME_ROOT already reflects --dsh-home (or $DSH_HOME / ~/.dsh) via install-common.sh.
PROFILE_ROOT="$DSH_HOME_ROOT/profiles/$DSH_PROFILE"
PLUGINS_ROOT="$PROFILE_ROOT/plugins"
TARGET="$PLUGINS_ROOT/dsh-live-voice-kokoro"

# Live-profile refusal happens on the mutating path only: a dry run is
# read-only and always allowed (it states the live requirement in its plan).
if [[ "$DRY_RUN" == "1" ]]; then
  log_plan "package root: $PACKAGE_ROOT"
  log_plan "target snapshot: $TARGET"
  log_plan "profile link: link:plugins/dsh-live-voice-kokoro (profile '$DSH_PROFILE')"
  log_plan "steps: run checks (unless DSH_DEPLOY_SKIP_CHECK=1) -> symlink-free rsync stage -> atomic swap -> profile link verify"
  if is_live_target "$PROFILE_ROOT" || { [[ ! -d "$PROFILE_ROOT" ]] && is_live_target "$DSH_HOME_ROOT"; }; then
    log_plan "note: target is live; --apply also needs --allow-live + DSH_WATCH_MAINTENANCE_CONFIRM=1"
  else
    log_plan "note: target is an isolated home (existing profile alone is not live); --apply proceeds without live confirmation"
  fi
  finish_if_dry_run
  exit 0
fi

if [[ -d "$PROFILE_ROOT" ]]; then
  # An existing profile directory alone is NOT liveness (review/test homes
  # pre-create it): refuse only when the profile itself is live per policy.
  refuse_live_target "$PROFILE_ROOT" "DSH profile '$DSH_PROFILE'" || exit 1
else
  # A not-yet-existing profile under the default home is still live state.
  refuse_live_target "$DSH_HOME_ROOT" "DSH home" || exit 1
fi
# Traversal guard: the profile, plugin, and target roots must stay inside the
# selected DSH home even with `..` segments or symlinked parents.
require_within "$DSH_HOME_ROOT" "$PROFILE_ROOT" 'profile root' || exit 1
require_within "$DSH_HOME_ROOT" "$PLUGINS_ROOT" 'plugins root' || exit 1
require_within "$DSH_HOME_ROOT" "$TARGET" 'plugin target' || exit 1

mkdir -p "$PLUGINS_ROOT"
STAGE="$(mktemp -d "$PLUGINS_ROOT/.dsh-live-voice-stage.XXXXXX")"
BACKUP="$PLUGINS_ROOT/.dsh-live-voice-backup.$$"
PROFILE_METADATA_BACKUP="$(mktemp -d "$DSH_HOME_ROOT/.dsh-live-voice-profile-metadata.XXXXXX")"
SWAPPED=0
METADATA_SNAPSHOTTED=0
COMMITTED=0

restore_profile_metadata() {
  for item in package.json pnpm-lock.yaml node_modules; do
    rm -rf "$PROFILE_ROOT/$item"
    if [[ -e "$PROFILE_METADATA_BACKUP/$item" || -L "$PROFILE_METADATA_BACKUP/$item" ]]; then
      cp -a "$PROFILE_METADATA_BACKUP/$item" "$PROFILE_ROOT/$item"
    fi
  done
}

cleanup() {
  local status=$?
  if ((COMMITTED == 0)); then
    if ((METADATA_SNAPSHOTTED == 1)); then
      restore_profile_metadata
    fi
    if ((SWAPPED == 1)); then
      rm -rf "$TARGET"
      if [[ -e "$BACKUP" ]]; then
        mv "$BACKUP" "$TARGET"
      fi
    fi
  fi
  rm -rf "$STAGE" "$BACKUP" "$PROFILE_METADATA_BACKUP"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cd "$PACKAGE_ROOT"
if [[ "${DSH_DEPLOY_SKIP_CHECK:-0}" != "1" ]]; then
  npx --yes pnpm@10.15.1 run check
fi
SOURCE_LINK="$(find "$PACKAGE_ROOT" \
  \( -path "$PACKAGE_ROOT/node_modules" -o -path "$PACKAGE_ROOT/.git" \) -prune \
  -o -type l -print -quit)"
if [[ -n "$SOURCE_LINK" ]]; then
  printf 'Refusing to copy source symbolic link: %s\n' "$SOURCE_LINK" >&2
  exit 1
fi

rsync -a --delete \
  --exclude=node_modules \
  --exclude=.git \
  --exclude='*.tsbuildinfo' \
  "$PACKAGE_ROOT/" "$STAGE/"

if [[ -n "$(find "$STAGE" -type l -print -quit)" ]]; then
  printf 'Refusing to deploy a plugin snapshot containing symbolic links.\n' >&2
  exit 1
fi
for required in package.json pnpm-lock.yaml lib/index.js lib/client.js resources/install-live-voice-runtime.sh; do
  [[ -e "$STAGE/$required" ]] || { printf 'Staged plugin is missing %s\n' "$required" >&2; exit 1; }
done

for item in package.json pnpm-lock.yaml node_modules; do
  if [[ -e "$PROFILE_ROOT/$item" || -L "$PROFILE_ROOT/$item" ]]; then
    cp -a "$PROFILE_ROOT/$item" "$PROFILE_METADATA_BACKUP/$item"
  fi
done
METADATA_SNAPSHOTTED=1

if [[ -e "$TARGET" ]]; then
  mv "$TARGET" "$BACKUP"
fi
mv "$STAGE" "$TARGET"
SWAPPED=1

if [[ -n "${DSH_DEPLOY_DSH_BIN:-}" ]]; then
  DSH_HOME="$DSH_HOME_ROOT" "$DSH_DEPLOY_DSH_BIN" plugin --profile "$DSH_PROFILE" add 'link:plugins/dsh-live-voice-kokoro'
else
  DSH_BIN="$(command -v dsh || true)"
  [[ -n "$DSH_BIN" ]] || { printf 'No dsh executable found (override with DSH_DEPLOY_DSH_BIN).\n' >&2; exit 1; }
  DSH_HOME="$DSH_HOME_ROOT" "$DSH_BIN" plugin --profile "$DSH_PROFILE" add 'link:plugins/dsh-live-voice-kokoro'
fi

PROFILE_PACKAGE="$PROFILE_ROOT/package.json" PROFILE_ROOT="$PROFILE_ROOT" TARGET="$TARGET" node <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const profile = JSON.parse(fs.readFileSync(process.env.PROFILE_PACKAGE, 'utf8'))
const actual = profile.dependencies?.['dsh-live-voice-kokoro']
if (actual !== 'link:plugins/dsh-live-voice-kokoro') {
  throw new Error(`Unexpected installed dependency: ${String(actual)}`)
}
const installedLink = path.join(process.env.PROFILE_ROOT, 'node_modules', 'dsh-live-voice-kokoro')
const resolvedLink = fs.realpathSync(installedLink)
const resolvedTarget = fs.realpathSync(process.env.TARGET)
if (resolvedLink !== resolvedTarget) {
  throw new Error(`Plugin link resolved outside the profile snapshot: ${resolvedLink}`)
}
NODE

COMMITTED=1
rm -rf "$BACKUP" "$PROFILE_METADATA_BACKUP"
printf 'Deployed self-contained Live Voice plugin to %s\n' "$TARGET"
