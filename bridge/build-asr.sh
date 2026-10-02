#!/bin/sh
# Compile the Swift ASR helper (watch mic PCM -> transcripts).
#
# Dry-run by default with no args? No — building is explicit (`build`), and
# `--dry-run` prints the compile command plus staging plan without running it.
# Nothing is installed to live paths from here.
#
# Env: ASR_OUT (default <bridge>/bin/watch-asr), SWIFTFLAGS (extra flags).
# Usage: ./build-asr.sh build [--dry-run] | ./build-asr.sh --dry-run | ./build-asr.sh clean
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC="$HERE/asr-helper.swift"
ASR_OUT="${ASR_OUT:-$HERE/bin/watch-asr}"

dry_run=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
  esac
done

compile_cmd() {
  # shellcheck disable=SC2086
  echo "swiftc -O $SRC -o $ASR_OUT -framework AVFoundation -framework Speech ${SWIFTFLAGS:-}"
}

case "${1:-}" in
  build)
    if [ "$dry_run" = 1 ]; then
      echo "would: mkdir -p $(dirname "$ASR_OUT")"
      echo "would: $(compile_cmd)"
      exit 0
    fi
    mkdir -p "$(dirname "$ASR_OUT")"
    # shellcheck disable=SC2086
    swiftc -O "$SRC" -o "$ASR_OUT" -framework AVFoundation -framework Speech ${SWIFTFLAGS:-}
    chmod 755 "$ASR_OUT"
    echo "built $ASR_OUT"
    ;;
  clean)
    rm -f "$ASR_OUT"
    echo "removed $ASR_OUT"
    ;;
  --dry-run)
    echo "would: mkdir -p $(dirname "$ASR_OUT")"
    echo "would: $(compile_cmd)"
    ;;
  *) echo "usage: $0 {build [--dry-run]|--dry-run|clean}" >&2; exit 2 ;;
esac
