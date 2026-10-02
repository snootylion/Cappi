#!/bin/sh
# tools/verify.sh — single release-verification entrypoint.
#
# Runs every check that is safe in any checkout: no network, no live DSH
# installation, no harness restart, no Gradle, no pnpm, no installers.
# (Heavier suites — Android, bridge Node tests, plugin pnpm checks — run in
# CI; see .github/workflows/ci.yml. Installer plan-mode runs via
# tools/installer-dryrun.sh --bridge-only.)
#
# Steps: secret scan, asset validation, binary inspection, license-gate
# status (advisory here — enforced by release-bundle.sh), SBOM generation
# to a temp dir, export --dry-run, and the tools/ Python test suite.
#
# Usage: ./tools/verify.sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FAIL=0

step() {
  echo "===== $1 ====="
}

run() {
  # run <label> <cmd...>: never aborts the whole script on failure.
  label="$1"; shift
  if "$@" ; then
    echo "ok: $label"
  else
    echo "FAIL: $label" >&2
    FAIL=1
  fi
}

step "1/7 secret/PII/path scan (paths+counts only, values never printed)"
run "scan-secrets" python3 "$ROOT/tools/scan-secrets.py" --root "$ROOT"

step "2/7 asset validation"
run "validate-assets" python3 "$ROOT/tools/validate-assets.py" --root "$ROOT"

step "3/7 shipped-binary inspection (metadata only, nothing executed)"
run "inspect-binaries" python3 "$ROOT/tools/inspect-binaries.py" --root "$ROOT"

step "4/7 license/publication gate status (advisory; enforced at bundle time)"
if python3 "$ROOT/tools/check-license-gate.py" --root "$ROOT"; then
  echo "ok: gates closed"
else
  echo "note: publication gates open (expected pre-release; LOCAL builds unaffected)"
fi

step "5/7 SBOM generation (upstream metadata only, no weights bundled)"
# Portable template (BSD + GNU mktemp): -t without XXXXXX fails on GNU.
SBOM_TMP=$(mktemp "${TMPDIR:-/tmp}/sbom.XXXXXX")
run "sbom" python3 "$ROOT/tools/sbom.py" --root "$ROOT" --out "$SBOM_TMP"
rm -f "$SBOM_TMP"

step "6/7 reproducible export (dry-run: allowlist resolution only)"
run "export-dry-run" "$ROOT/tools/export-source.sh" --dry-run

step "7/7 tools test suite (stdlib unittest, temp dirs only)"
run "tools-tests" python3 -m unittest discover -s "$ROOT/tools/tests" -t "$ROOT/tools" -v

echo "=============================="
if [ "$FAIL" = 0 ]; then
  echo "VERIFY PASS (tools checks only — publication gates reported above;"
  echo "a PASS here does NOT close the gates or approve publication)"
else
  echo "VERIFY FAIL" >&2
fi
exit "$FAIL"
