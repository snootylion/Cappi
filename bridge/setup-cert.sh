#!/bin/sh
# Generate a private local TLS certificate for the watch bridge.
#
# The certificate is SELF-SIGNED and LOCAL ONLY: the watch pins its SHA-256
# fingerprint at pairing time (printed by the bridge at startup), so no public
# CA is involved and none is needed. The private key is created with 0600 and
# must NEVER be committed (see .gitignore: *.pem).
#
# Usage:
#   BRIDGE_STATE_DIR=~/.local/state/dsh-watch-bridge ./setup-cert.sh
#   ./setup-cert.sh --dry-run        # print what would run, change nothing
#   ./setup-cert.sh --fingerprint    # print the sha256 pin of the current cert
#
# Env: BRIDGE_STATE_DIR (default ~/.local/state/dsh-watch-bridge),
#      CERT_DAYS (default 825), CERT_HOST (label only, default dsh-watch-bridge).
set -eu

STATE_DIR="${BRIDGE_STATE_DIR:-$HOME/.local/state/dsh-watch-bridge}"
CERT="$STATE_DIR/bridge-cert.pem"
KEY="$STATE_DIR/bridge-key.pem"
DAYS="${CERT_DAYS:-825}"
LABEL="${CERT_HOST:-dsh-watch-bridge}"

dry_run=0
fingerprint_only=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --fingerprint) fingerprint_only=1 ;;
    -h|--help)
      echo "usage: $0 [--dry-run] [--fingerprint]" >&2
      echo "  writes \$BRIDGE_STATE_DIR/bridge-cert.pem + bridge-key.pem (0600)" >&2
      exit 0 ;;
    *) echo "unknown flag: $arg (see --help)" >&2; exit 2 ;;
  esac
done

if [ "$fingerprint_only" = 1 ]; then
  if [ ! -f "$CERT" ]; then echo "no certificate at $CERT (run without flags first)" >&2; exit 1; fi
  openssl x509 -in "$CERT" -outform DER | openssl dgst -sha256 -binary | openssl base64 -A
  echo
  exit 0
fi

if [ "$dry_run" = 1 ]; then
  echo "would: mkdir -p (0700) $STATE_DIR"
  echo "would: openssl req -x509 -newkey rsa:2048 -sha256 -days $DAYS -nodes"
  echo "         -keyout $KEY -out $CERT -subj \"/CN=$LABEL\""
  echo "would: chmod 0600 $KEY $CERT"
  exit 0
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
if [ -f "$KEY" ] || [ -f "$CERT" ]; then
  echo "refusing: $KEY or $CERT already exists (back it up and remove it to rotate)" >&2
  exit 1
fi
# Hostname/IP is intentionally NOT bound here: the watch pins the exact
# certificate (stable bridge identity across DHCP changes), and hostname
# verification is subsumed by that pin (see SecureTransport.kt).
openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -keyout "$KEY" -out "$CERT" -subj "/CN=$LABEL" 2>/dev/null
chmod 600 "$KEY" "$CERT"
echo "wrote $CERT and $KEY (0600)"
echo -n "certificate pin (enter on the watch at pairing): sha256/"
openssl x509 -in "$CERT" -outform DER | openssl dgst -sha256 -binary | openssl base64 -A
echo
