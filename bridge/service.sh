#!/bin/sh
# Keep the LAN watch bridge alive across terminal/API sessions and Mac logins.
#
# Never executes a live install without review: `install --dry-run` stages the
# plist to a temp file and prints it. Ports, state dir and TLS paths are
# configurable via env so installs never depend on hardcoded paths.
#
# Env: BRIDGE_PORT (8787), BRIDGE_DISCOVERY_PORT (8788),
#      BRIDGE_STATE_DIR (~/.local/state/dsh-watch-bridge),
#      BRIDGE_TLS_CERT / BRIDGE_TLS_KEY (default <state>/bridge-*.pem),
#      BRIDGE_ALLOW_INSECURE_HTTP (empty by default — TLS enforced),
#      DSH_BASE (http://127.0.0.1:3083).
set -eu

LABEL=dev.dsh.watch.bridge
DOMAIN="gui/$(id -u)"
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/DSHWatch"
NODE=$(command -v node)

BRIDGE_PORT="${BRIDGE_PORT:-8787}"
BRIDGE_DISCOVERY_PORT="${BRIDGE_DISCOVERY_PORT:-8788}"
BRIDGE_STATE_DIR="${BRIDGE_STATE_DIR:-$HOME/.local/state/dsh-watch-bridge}"
BRIDGE_TLS_CERT="${BRIDGE_TLS_CERT:-$BRIDGE_STATE_DIR/bridge-cert.pem}"
BRIDGE_TLS_KEY="${BRIDGE_TLS_KEY:-$BRIDGE_STATE_DIR/bridge-key.pem}"
BRIDGE_ALLOW_INSECURE_HTTP="${BRIDGE_ALLOW_INSECURE_HTTP:-}"
DSH_BASE="${DSH_BASE:-http://127.0.0.1:3083}"

write_plist() {
  # $1 = destination plist path
  python3 - "$1" "$LABEL" "$HERE" "$NODE" "$LOGDIR" \
    "$BRIDGE_PORT" "$BRIDGE_DISCOVERY_PORT" "$BRIDGE_STATE_DIR" \
    "$BRIDGE_TLS_CERT" "$BRIDGE_TLS_KEY" "$BRIDGE_ALLOW_INSECURE_HTTP" "$DSH_BASE" <<'PY'
import plistlib, sys
from pathlib import Path
(path, label, root, node, logs, port, dport, statedir,
 cert, key, insecure, dsh) = sys.argv[1:]
env = {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
       'BRIDGE_PORT': port, 'BRIDGE_DISCOVERY_PORT': dport,
       'BRIDGE_STATE_DIR': statedir, 'BRIDGE_TLS_CERT': cert,
       'BRIDGE_TLS_KEY': key, 'DSH_BASE': dsh}
if insecure:
    env['BRIDGE_ALLOW_INSECURE_HTTP'] = insecure
config = {
    'Label': label,
    'ProgramArguments': [node, str(Path(root) / 'bridge.mjs')],
    'WorkingDirectory': root,
    'EnvironmentVariables': env,
    'RunAtLoad': True,
    'KeepAlive': True,
    'ThrottleInterval': 10,
    'StandardOutPath': str(Path(logs) / 'bridge.log'),
    'StandardErrorPath': str(Path(logs) / 'bridge-error.log'),
}
with open(path, 'wb') as file:
    plistlib.dump(config, file)
Path(path).chmod(0o600)
PY
}

case "${1:-status}" in
  install)
    if [ "${2:-}" = "--dry-run" ]; then
      staged=$(mktemp -t dsh-bridge-plist)
      write_plist "$staged"
      echo "staged (not installed): $staged"
      cat "$staged"
      exit 0
    fi
    mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"
    chmod 700 "$LOGDIR"
    touch "$LOGDIR/bridge.log" "$LOGDIR/bridge-error.log"
    chmod 600 "$LOGDIR/bridge.log" "$LOGDIR/bridge-error.log"
    write_plist "$PLIST"
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Watch bridge installed as $LABEL"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    echo "Watch bridge service removed (private logs retained in $LOGDIR)"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" | grep -E '^[[:space:]]*(state|pid|last exit code) =' || true
    # Loopback only; -k is acceptable here (health is unauthenticated, and the
    # pin is verified by the watch, not by this status probe).
    curl -fsSk --max-time 4 "https://127.0.0.1:${BRIDGE_PORT}/watch/health" \
      || curl -fsS --max-time 4 "http://127.0.0.1:${BRIDGE_PORT}/watch/health"
    echo
    ;;
  *) echo "usage: $0 {install [--dry-run]|status|uninstall}" >&2; exit 2 ;;
esac
