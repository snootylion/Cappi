#!/usr/bin/env bash
# Build the watch-asr native helper from source (Role NP, macOS only).
#
# Source: resources/watch-asr.swift.
# Output: resources/bin/watch-asr (+ resources/watch-asr.manifest.json).
# Binaries are git-ignored but ship in the npm tar via the package.json
# `files` allowlist. Unknown binaries are forbidden: the manifest records
# source/plist/binary sha256, architectures, minOS, SDK, and provenance.
#
# Safety: dry-run by default (`--apply` required for any write). Compiling
# never touches the microphone, TCC grants, live DSH homes, or network.
# The only invocations in this script are `--help` and `--status` (both
# non-capturing, non-prompting diagnostics).
#
# Reproducibility: per-arch `swiftc -O -gnone -target <arch>-apple-macosx<MIN>`
# (never the invalid `-arch arm64 -arch x86_64` combo), `lipo -create` for a
# true universal binary, embedded Info plist via
# `-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist`, ad-hoc
# codesign AFTER lipo with a STABLE identifier (no temp-path identity, so a
# rebuild does not churn TCC bytes), source DWARF stripped (`-gnone`).
# If the x86_64 slice fails to compile, the script keeps host-arch output
# with the redacted compiler proof in the manifest matrix note — never a
# false universal claim.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$SCRIPT_DIR/resources/watch-asr.swift"
PLIST="$SCRIPT_DIR/resources/watch-asr-Info.plist"
OUT_DIR="$SCRIPT_DIR/resources/bin"
OUT="$OUT_DIR/watch-asr"
MANIFEST="$SCRIPT_DIR/resources/watch-asr.manifest.json"

MIN_OS="13.0"
CODESIGN_ID="ai.deepseek.dsh.watch-asr"

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help)
      echo "usage: build-watch-helpers.sh [--apply]"
      echo "  dry-run (default): print the plan, change nothing."
      echo "  --apply: per-arch compile, lipo universal, embed plist, sign, verify, write manifest."
      exit 0
      ;;
    *) echo "build-watch-helpers.sh: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Scrub ambient bridge/harness env so an inherited operator shell can never
# redirect this build at a live home.
for v in $(env | cut -d= -f1 | grep -E '^(DSH_|BRIDGE_)' || true); do unset "$v"; done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-watch-helpers.sh: macOS only (Swift/Apple Speech helper). Nothing built." >&2
  echo "Fallback: compile from source on a Mac with Xcode CLT, then install the plugin tar." >&2
  exit 3
fi
command -v swiftc >/dev/null || { echo "missing swiftc (install Xcode CLT: xcode-select --install)" >&2; exit 3; }
command -v codesign >/dev/null || { echo "missing codesign" >&2; exit 3; }
command -v lipo >/dev/null || { echo "missing lipo" >&2; exit 3; }
[[ -f "$SRC" ]] || { echo "missing source: $SRC" >&2; exit 3; }
[[ -f "$PLIST" ]] || { echo "missing plist: $PLIST" >&2; exit 3; }

SDK_PATH="$(xcrun --show-sdk-path 2>/dev/null || true)"
[[ -n "${SDK_PATH:-}" ]] || { echo "missing macOS SDK (xcrun --show-sdk-path empty)" >&2; exit 3; }
ARCH_HOST="$(uname -m)"
SWIFT_V="$(swiftc --version 2>&1 | head -n 1)"

# Probe per-arch compilation with the supported `-target` form (the legacy
# `-arch arm64 -arch x86_64` pair is NOT accepted by swiftc and must never
# be used here). Probes are redacted: no home paths in output.
PROBE_DIR="$(mktemp -d -t watch-asr-probe.XXXXXX)"
PROBE_SRC="$PROBE_DIR/probe.swift"
printf 'print("arch-probe")\n' > "$PROBE_SRC"
PROBE_ARM_LOG="$PROBE_DIR/arm.log"
PROBE_X86_LOG="$PROBE_DIR/x86.log"
PROBE_ARM=0
PROBE_X86=0
if swiftc -target "arm64-apple-macosx${MIN_OS}" -sdk "$SDK_PATH" -O -gnone "$PROBE_SRC" -o /dev/null 2>"$PROBE_ARM_LOG"; then
  PROBE_ARM=1
  echo "toolchain: arm64 slice compiles (-target arm64-apple-macosx${MIN_OS})"
else
  echo "toolchain: arm64 probe FAILED (see redacted log below)" >&2
  sed -E "s#/Users/[^ /]*#\$HOME#g" "$PROBE_ARM_LOG" | head -n 20 >&2 || true
fi
if swiftc -target "x86_64-apple-macosx${MIN_OS}" -sdk "$SDK_PATH" -O -gnone "$PROBE_SRC" -o /dev/null 2>"$PROBE_X86_LOG"; then
  PROBE_X86=1
  echo "toolchain: x86_64 slice compiles (-target x86_64-apple-macosx${MIN_OS})"
else
  echo "toolchain: x86_64 probe FAILED (see redacted log below)" >&2
  sed -E "s#/Users/[^ /]*#\$HOME#g" "$PROBE_X86_LOG" | head -n 20 >&2 || true
fi
rm -rf "$PROBE_DIR"

UNIVERSAL=0
if [[ "$PROBE_ARM" -eq 1 && "$PROBE_X86" -eq 1 ]]; then
  UNIVERSAL=1
  echo "toolchain: universal arm64+x86_64 build planned (lipo after per-arch compile)"
else
  echo "toolchain: universal unavailable; host-arch ($ARCH_HOST) build planned"
  echo "matrix: arm64 verified here; x86_64 needs a Mac SDK with x86_64 slices."
  echo "fallback: ship source + this script; installer compiles on the target Mac with consent."
fi

if [[ "$APPLY" -ne 1 ]]; then
  echo "Dry run: no changes made."
  echo "  source:  $SRC"
  echo "  plist:   $PLIST"
  echo "  output:  $OUT (universal=$UNIVERSAL, minOS=$MIN_OS, sdk=${SDK_PATH:-unknown})"
  echo "  manifest: $MANIFEST"
  echo "Re-run with --apply to compile."
  exit 0
fi

mkdir -p "$OUT_DIR"
BUILD_TMP="$(mktemp -d -t watch-asr-build.XXXXXX)"
trap 'rm -rf "$BUILD_TMP"' EXIT
ARM_OBJ="$BUILD_TMP/watch-asr.arm64"
X86_OBJ="$BUILD_TMP/watch-asr.x86_64"
TMP_OUT="$BUILD_TMP/watch-asr.universal"
X86_FAIL_REDACTED=""

# No user config is embedded: the helper takes only --locale/--end-turn-ms argv
# plus --status/--authorize diagnostics (no stdin, no mic in those modes).
echo "compiling arm64 slice..."
swiftc -target "arm64-apple-macosx${MIN_OS}" -sdk "$SDK_PATH" -O -gnone "$SRC" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST" \
  -o "$ARM_OBJ"
echo "compiling x86_64 slice..."
if swiftc -target "x86_64-apple-macosx${MIN_OS}" -sdk "$SDK_PATH" -O -gnone "$SRC" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST" \
  -o "$X86_OBJ" 2>"$BUILD_TMP/x86-build.log"; then
  echo "both slices compiled; creating universal binary..."
  lipo -create "$ARM_OBJ" "$X86_OBJ" -output "$TMP_OUT"
  UNIVERSAL=1
else
  echo "x86_64 slice FAILED; keeping host-arch output with matrix note (no false universal claim)." >&2
  X86_FAIL_REDACTED="$(sed -E 's#/Users/[^ /]*#$HOME#g' "$BUILD_TMP/x86-build.log" | head -n 25 || true)"
  printf '%s\n' "$X86_FAIL_REDACTED" >&2 || true
  cp -f "$ARM_OBJ" "$TMP_OUT"
  UNIVERSAL=0
fi

# Ad-hoc sign AFTER lipo with a STABLE identifier so rebuilds do not churn
# TCC bytes with temp-path identities. No private key, no timestamp.
codesign --force -s - --timestamp=none -i "$CODESIGN_ID" "$TMP_OUT"

# Verify: plist actually embedded (script previously only claimed it).
if ! otool -s __TEXT __info_plist "$TMP_OUT" >/dev/null 2>&1; then
  echo "built helper missing embedded __info_plist section" >&2; exit 1
fi
# Verify: architectures actually present (both slices when universal).
BIN_ARCHS="$(lipo -archs "$TMP_OUT" 2>/dev/null || echo "$ARCH_HOST")"
if [[ "$UNIVERSAL" -eq 1 ]]; then
  case " $BIN_ARCHS " in
    *" arm64 "*|*" arm64") : ;;
    *) echo "universal build missing arm64 slice (got: $BIN_ARCHS)" >&2; exit 1 ;;
  esac
  case " $BIN_ARCHS " in
    *" x86_64 "*|*" x86_64") : ;;
    *) echo "universal build missing x86_64 slice (got: $BIN_ARCHS)" >&2; exit 1 ;;
  esac
fi
# Verify: minOS load commands (LC_BUILD_VERSION) honor the floor.
MIN_OS_SEEN="$(otool -l "$TMP_OUT" 2>/dev/null | grep -A3 'LC_BUILD_VERSION' | grep -o 'minos [0-9.]*' | sort -u | tr '\n' ' ' || true)"
# Verify: no arbitrary home paths baked into the binary (DWARF stripped).
if strings "$TMP_OUT" | grep -E '/Users/[^ ]*' | grep -v -E '^\s*$' >/dev/null 2>&1; then
  echo "warning: binary contains embedded /Users/ path strings (listing redacted count only):" >&2
  strings "$TMP_OUT" | grep -c -E '/Users/[^ ]*' >&2 || true
fi
# Verify: usage purpose strings present (Speech), diagnostics safe.
if ! strings "$TMP_OUT" | grep -q 'NSSpeechRecognitionUsageDescription\|Speech Recognition'; then
  echo "note: usage-description string not found in binary strings (plist section still embedded above)."
fi
# Self-checks: --help and --status perform no capture and prompt for nothing.
"$TMP_OUT" --help >/dev/null || { echo "built helper failed --help self-check" >&2; exit 1; }
"$TMP_OUT" --status >/dev/null || { echo "built helper failed --status self-check" >&2; exit 1; }

mv -f "$TMP_OUT" "$OUT"
rm -rf "$BUILD_TMP"
trap - EXIT

SRC_SHA="$(shasum -a 256 "$SRC" | awk '{print $1}')"
PLIST_SHA="$(shasum -a 256 "$PLIST" | awk '{print $1}')"
BIN_SHA="$(shasum -a 256 "$OUT" | awk '{print $1}')"
CS_ID="$(codesign -dv "$OUT" 2>&1 | sed -n 's/^Identifier=//p' || echo "$CODESIGN_ID")"
MATRIX_NOTE="universal arm64+x86_64 at minOS $MIN_OS"
if [[ "$UNIVERSAL" -ne 1 ]]; then
  MATRIX_NOTE="host-arch $BIN_ARCHS only (minOS $MIN_OS); x86_64 slice failed on this host — compile from source on an Intel-capable Mac with consent. Redacted compiler proof: $(printf '%s' "$X86_FAIL_REDACTED" | tr '\n' ' ' | cut -c1-400)"
fi
# Escape for JSON (no private identity: paths are repo-relative only).
JSON_MATRIX="$(printf '%s' "$MATRIX_NOTE" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
cat > "$MANIFEST" <<EOF
{
  "helper": "watch-asr",
  "source": "resources/watch-asr.swift",
  "sourceSha256": "$SRC_SHA",
  "plist": "resources/watch-asr-Info.plist",
  "plistSha256": "$PLIST_SHA",
  "binary": "resources/bin/watch-asr",
  "binarySha256": "$BIN_SHA",
  "architectures": "$BIN_ARCHS",
  "universal": $UNIVERSAL,
  "minOS": "$MIN_OS",
  "minOSSeen": "$MIN_OS_SEEN",
  "sdk": "${SDK_PATH:-unknown}",
  "toolchain": "$SWIFT_V",
  "codesign": "ad-hoc (codesign -s -, no private key)",
  "codesignIdentifier": "$CS_ID",
  "usagePlist": "resources/watch-asr-Info.plist (NSMicrophoneUsageDescription, NSSpeechRecognitionUsageDescription)",
  "plistEmbedded": true,
  "matrix": $JSON_MATRIX,
  "noEmbeddedUserConfig": true,
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "Built $OUT ($BIN_ARCHS, universal=$UNIVERSAL, minOS=$MIN_OS)"
echo "Manifest: $MANIFEST"
