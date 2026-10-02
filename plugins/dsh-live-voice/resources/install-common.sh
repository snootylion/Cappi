#!/usr/bin/env bash
# install-common.sh — shared safety helpers for D-owned release installers.
#
# This file is SOURCED, never executed. It provides:
#   - dry-run by default (`--apply` required to mutate anything),
#   - portable path resolution (`DSH_HOME`, `--dsh-home`, `--profile`,
#     `--runtime-root`; no hardcoded user paths),
#   - refusal to target the live production profile unless the operator
#     passes `--allow-live` AND confirms via `DSH_WATCH_MAINTENANCE_CONFIRM=1`
#     (an explicit outside-session maintenance confirmation; never set by
#     automation).
#
# Sourcing contract: the caller sets SCRIPT_NAME (for usage text) before
# sourcing, then calls `parse_common_args "$@"` and shifts the consumed args.
#
# LIVENESS POLICY (explicit): a target is "live" — the operator's real,
# possibly-running Harness state — when ANY holds:
#   1. its canonical path sits inside the ACTIVE inherited `$DSH_HOME`, when
#      that home is itself live (inside a live anchor below, inside the
#      OS-recorded tree, or carrying harness markers at its own root) — a
#      synthetic isolated `$DSH_HOME` selected for review/tests never
#      self-flags, while an ambient `$DSH_HOME` pointing at real or custom
#      live state cannot be hidden by the target selection (REPORT-K), or
#   2. its canonical path sits inside a live DSH home (`$HOME/.dsh` or the
#      OS-recorded uid home's `.dsh`), or
#   3. its canonical path sits inside a live runtime root: the default
#      `Library/Application Support/DeepSeek Harness` tree under `$HOME` or
#      the OS-recorded home — or anywhere inside the OS-recorded home tree
#      at all (review/test homes use synthetic temp roots, never the real
#      home, so this never flags isolated tests), or
#   4. it already contains harness runtime state markers (sessions/,
#      sessions.json, settings.yaml, settings.json).
# An existing profile/plugin directory ALONE is not liveness: review and test
# homes pre-create it. In particular, installer defaults (default DSH home +
# default profile) ALWAYS resolve to a live target, so a bare `--apply` with
# no explicit isolated `--dsh-home` refuses without `--allow-live` plus
# `DSH_WATCH_MAINTENANCE_CONFIRM=1`. All comparisons run on canonical paths
# (see canonical_path): `..` segments and symlinks cannot escape the check.

# Guard against double-sourcing.
if [[ -n "${DSH_WATCH_INSTALL_COMMON_LOADED:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi
DSH_WATCH_INSTALL_COMMON_LOADED=1

# --- mutable installer state (callers must not pre-set) -----------------------
DRY_RUN=1
ALLOW_LIVE=0
DSH_HOME_ROOT="${DSH_HOME:-$HOME/.dsh}"
DSH_PROFILE="${DSH_PROFILE:-web}"
RUNTIME_ROOT_OVERRIDE=""
# The ACTIVE inherited DSH home (custom location outside ~/.dsh): captured at
# source time, before --dsh-home can override DSH_HOME_ROOT. The liveness
# check consults it so an ambient DSH_HOME pointing at real state cannot be
# hidden by selecting an isolated --dsh-home for the target while the
# inherited home still anchors live state (REPORT-K incident).
_DSH_COMMON_INHERITED_DSH_HOME="${DSH_HOME:-}"

common_usage_tail() {
  printf '  --apply            Perform the install (default is --dry-run: print the plan and exit 0).\n'
  printf '  --dry-run          Print the plan without changing anything (default).\n'
  printf '  --dsh-home PATH    DSH home root (default: $DSH_HOME or ~/.dsh).\n'
  printf '  --profile NAME     Profile name under the DSH home (default: web).\n'
  printf '  --runtime-root PATH\n'
  printf '                     Override the plugin runtime root.\n'
  printf '  --allow-live       Permit targeting an existing live profile. ALSO requires\n'
  printf '                     DSH_WATCH_MAINTENANCE_CONFIRM=1 in the environment.\n'
  printf '  -h, --help         Show usage.\n'
}

# Parses the shared flags. Sets CONSUMED_ARGC to the number of "$@" entries
# consumed so the caller can `shift "$CONSUMED_ARGC"`.
parse_common_args() {
  CONSUMED_ARGC=0
  while (($# > 0)); do
    case "$1" in
      --apply) DRY_RUN=0; shift; CONSUMED_ARGC=$((CONSUMED_ARGC + 1)) ;;
      --dry-run) DRY_RUN=1; shift; CONSUMED_ARGC=$((CONSUMED_ARGC + 1)) ;;
      --dsh-home)
        [[ $# -ge 2 ]] || { printf 'Missing value for --dsh-home\n' >&2; return 2; }
        DSH_HOME_ROOT="$2"; shift 2; CONSUMED_ARGC=$((CONSUMED_ARGC + 2)) ;;
      --profile)
        [[ $# -ge 2 ]] || { printf 'Missing value for --profile\n' >&2; return 2; }
        DSH_PROFILE="$2"; shift 2; CONSUMED_ARGC=$((CONSUMED_ARGC + 2)) ;;
      --runtime-root)
        [[ $# -ge 2 ]] || { printf 'Missing value for --runtime-root\n' >&2; return 2; }
        RUNTIME_ROOT_OVERRIDE="$2"; shift 2; CONSUMED_ARGC=$((CONSUMED_ARGC + 2)) ;;
      --allow-live) ALLOW_LIVE=1; shift; CONSUMED_ARGC=$((CONSUMED_ARGC + 1)) ;;
      -h|--help) return 3 ;;
      --) shift; CONSUMED_ARGC=$((CONSUMED_ARGC + 1)); break ;;
      *) break ;;
    esac
  done
  return 0
}

die() {
  printf '%s: %s\n' "${SCRIPT_NAME:-installer}" "$*" >&2
  return 1
}

log_plan() {
  printf '[plan] %s\n' "$*"
}

# Resolve a path to an absolute, symlink-free-if-possible form without
# requiring it to exist.
resolve_path() {
  local input="$1"
  case "$input" in
    ~) input="$HOME" ;;
    ~/*) input="$HOME/${input#~/}" ;;
  esac
  if [[ "$input" != /* ]]; then
    input="$PWD/$input"
  fi
  # Collapse // and /./ and trailing slashes textually; do not touch the fs.
  printf '%s\n' "$input" | sed -e 's#//*#/#g' -e 's#/\./#/#g' -e 's#/$##'
}

# Canonicalize a path for security comparisons using reliable filesystem
# canonicalization. Primary: python3 os.path.realpath (strict=False) —
# correct for symlink/../ (resolved physically in order, not lexically
# first), file symlinks, and non-existing trailing components; never fails.
# Fallback (no python3): lexical collapse plus physical resolution of the
# longest existing prefix with file-aware cd (dirname when the prefix is a
# file, not a directory). The fallback is best-effort and documented as such:
# prefer the python3 path on every supported host.
canonical_path() {
  local lexical
  lexical="$(resolve_path "$1")"
  if command -v python3 >/dev/null 2>&1; then
    local canon
    if canon="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$lexical" 2>/dev/null)" && [[ -n "$canon" ]]; then
      printf '%s\n' "$canon"
      return 0
    fi
    # python3 present but failed: fall through to the bash best-effort below.
  fi
  # --- bash fallback (best-effort, no python3) ---
  # Lexically resolve /../ without touching the filesystem.
  local resolved=""
  local IFS='/'
  # shellcheck disable=SC2162
  read -ra parts <<<"$lexical"
  for part in "${parts[@]}"; do
    case "$part" in
      ''|'.') continue ;;
      '..')
        resolved="${resolved%/*}"
        ;;
      *) resolved="$resolved/$part" ;;
    esac
  done
  [[ -n "$resolved" ]] || resolved="/"
  # Physically resolve symlinks for the longest existing prefix, then re-append
  # the non-existing remainder textually. File-aware: when the prefix names a
  # file (or symlink to a file), resolve its containing directory instead of
  # attempting cd into the file.
  local prefix="$resolved" suffix=""
  while [[ -n "$prefix" && ! -e "$prefix" && ! -L "$prefix" ]]; do
    suffix="/${prefix##*/}$suffix"
    prefix="${prefix%/*}"
    [[ -n "$prefix" ]] || { prefix="/"; break; }
  done
  if [[ -e "$prefix" || -L "$prefix" ]]; then
    local physical dir base
    if [[ -d "$prefix" && ! -L "$prefix" ]]; then
      physical="$(cd -P -- "$prefix" 2>/dev/null && pwd -P)" || physical="$prefix"
      printf '%s\n' "$physical$suffix" | sed -e 's#//*#/#g' -e 's#\(.\)/$#\1#'
    else
      # File or symlink (possibly to a file): resolve the parent directory
      # physically, then re-append the final component + remainder.
      dir="${prefix%/*}"
      base="${prefix##*/}"
      [[ -n "$dir" ]] || dir="/"
      physical="$(cd -P -- "$dir" 2>/dev/null && pwd -P)" || physical="$dir"
      # When the final component itself is a symlink, resolve one level via
      # readlink when available (keeps the fallback closer to realpath).
      if [[ -L "$prefix" ]] && command -v readlink >/dev/null 2>&1; then
        local link
        link="$(readlink "$prefix" 2>/dev/null)" || link=""
        if [[ -n "$link" ]]; then
          case "$link" in
            /*) printf '%s\n' "$link$suffix" | sed -e 's#//*#/#g' -e 's#\(.\)/$#\1#'; return 0 ;;
            *) printf '%s\n' "$physical/$link$suffix" | sed -e 's#//*#/#g' -e 's#\(.\)/$#\1#'; return 0 ;;
          esac
        fi
      fi
      printf '%s\n' "$physical/$base$suffix" | sed -e 's#//*#/#g' -e 's#\(.\)/$#\1#'
    fi
  else
    printf '%s\n' "$resolved"
  fi
}

# True (0) when canonical $2 is $1 itself or lives beneath it (slash-boundary
# aware, so /tmp/dsh-evil is NOT within /tmp/dsh).
path_within() {
  local parent child
  parent="$(canonical_path "$1")"
  child="$(canonical_path "$2")"
  [[ "$child" == "$parent" || "$child" == "$parent"/* ]]
}

# Refuse when the canonical child escapes the canonical parent (traversal or
# symlink escape). Call BEFORE any mutation that assumes containment.
require_within() {
  local parent="$1" child="$2" what="${3:-path}"
  if ! path_within "$parent" "$child"; then
    die "refusing ${what} '$(canonical_path "$child")': escapes '$(canonical_path "$parent")'"
    return 1
  fi
  return 0
}

# True (0) when the resolved target is the operator's live DSH state, per the
# LIVENESS POLICY above: canonical containment in a live DSH home (current
# $HOME, the OS-recorded uid home, or the ACTIVE inherited $DSH_HOME), in a
# live runtime root (the default Application Support tree under either home,
# or anywhere inside the OS-recorded home tree — synthetic test roots never
# live there), or harness runtime state markers. Comparisons use canonical
# paths, so `..` segments and symlinked parents cannot dodge the check.
#
# The OS-recorded home of the current uid, independent of $HOME (sandboxes
# legitimately override it) and of $DSH_HOME (often inherited ambiently).
# Best-effort: prints nothing when it cannot be determined.
os_recorded_home() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os, pwd; print(pwd.getpwuid(os.getuid()).pw_dir)' 2>/dev/null || true
  fi
}

is_live_target() {
  local target
  target="$(canonical_path "$1")"
  local recorded
  recorded="$(os_recorded_home)"
  # 1. The ACTIVE inherited DSH home — but ONLY when that home itself is live
  # state (inside a live home anchor, inside the recorded tree, or carrying
  # harness markers at its own root). A synthetic isolated DSH_HOME selected
  # for review/tests is not live, so selecting it never self-flags; an
  # ambient DSH_HOME pointing at real/custom live state cannot be hidden by
  # the target selection (REPORT-K escape).
  if [[ -n "${_DSH_COMMON_INHERITED_DSH_HOME:-}" ]]; then
    local inherited
    inherited="$(canonical_path "$_DSH_COMMON_INHERITED_DSH_HOME")"
    if [[ -n "$inherited" && "$inherited" != "/" ]] && _inherited_home_is_live "$inherited" "$recorded"; then
      if path_within "$inherited" "$target"; then
        return 0
      fi
    fi
  fi
  local home_base
  for home_base in "$HOME" "$recorded"; do
    [[ -n "$home_base" && "$home_base" != "/" ]] || continue
    if path_within "$home_base/.dsh" "$target"; then
      return 0
    fi
    # Live runtime roots, not only ~/.dsh: the live-voice/summary runtimes
    # default under ~/Library/Application Support/DeepSeek Harness.
    if path_within "$home_base/Library/Application Support/DeepSeek Harness" "$target"; then
      return 0
    fi
  done
  # Any target inside the OS-recorded home tree is operator state: isolated
  # review/test roots are synthetic temp dirs, never the real home.
  if [[ -n "$recorded" && "$recorded" != "/" ]] && path_within "$recorded" "$target"; then
    return 0
  fi
  for marker in sessions sessions.json settings.yaml settings.json; do
    if [[ -e "$target/$marker" ]]; then
      return 0
    fi
  done
  return 1
}

# True (0) when the canonical inherited DSH home is itself live state:
# inside a live home anchor, inside the OS-recorded tree, or carrying
# harness runtime markers at its own root. $2 is the recorded home (may be
# empty); callers pass it to avoid a second uid lookup per check.
_inherited_home_is_live() {
  local inherited="$1" recorded="${2:-}"
  local home_base
  for home_base in "$HOME" "$recorded"; do
    [[ -n "$home_base" && "$home_base" != "/" ]] || continue
    if path_within "$home_base/.dsh" "$inherited"; then
      return 0
    fi
    if path_within "$home_base/Library/Application Support/DeepSeek Harness" "$inherited"; then
      return 0
    fi
  done
  if [[ -n "$recorded" && "$recorded" != "/" ]] && path_within "$recorded" "$inherited"; then
    return 0
  fi
  local marker
  for marker in sessions sessions.json settings.yaml settings.json; do
    if [[ -e "$inherited/$marker" ]]; then
      return 0
    fi
  done
  return 1
}

# Refuse to mutate a live target without explicit maintenance confirmation.
# Must be called BEFORE any filesystem mutation.
refuse_live_target() {
  local target="$1"
  local what="${2:-target}"
  if is_live_target "$target"; then
    if [[ "$ALLOW_LIVE" != "1" || "${DSH_WATCH_MAINTENANCE_CONFIRM:-0}" != "1" ]]; then
      die "refusing to target live ${what} '${target}' without --allow-live and DSH_WATCH_MAINTENANCE_CONFIRM=1 (outside-session maintenance confirmation required)"
      return 1
    fi
  fi
  return 0
}

# In dry-run mode, print the pending plan and exit 0. Callers queue plan
# lines with log_plan() before invoking this.
finish_if_dry_run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf 'Dry run: no changes made. Re-run with --apply to perform the install.\n'
    return 0
  fi
  return 1
}
