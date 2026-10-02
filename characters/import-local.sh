#!/bin/bash
# characters/import-local.sh — generic local pack acquisition hook (dry-run first).
#
# Validates a candidate character source directory (pack.json + asset files)
# WITHOUT copying, downloading, or inventing rights. The operator confirms
# provenance; only then does --apply copy into the tree.
#
# Usage:
#   ./characters/import-local.sh --from <dir> [--to <dir>]        # dry-run validation
#   ./characters/import-local.sh --from <dir> --to <dir> --apply  # copy after review
#
# Policy: never fetches from the network, never touches live installs, never
# claims rights. Refuses traversal-unsafe filenames.
set -euo pipefail
FROM=""; TO=""; APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:-}"; shift 2;;
    --to) TO="${2:-}"; shift 2;;
    --apply) APPLY=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$FROM" ] || { echo "usage: import-local.sh --from <dir> [--to <dir>] [--apply]" >&2; exit 2; }
[ -f "$FROM/pack.json" ] || { echo "no pack.json in $FROM" >&2; exit 1; }

echo "== pack descriptor: $FROM/pack.json"
python3 - "$FROM/pack.json" <<'EOF'
import json, re, sys
doc = json.load(open(sys.argv[1]))
safe = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]*\.(gif|xml|png|webp)$')
assert doc.get("schema_version") == 2, "want schema_version 2"
for field in ("pack", "version", "author", "license"):
    assert doc.get(field), f"missing {field}"
print("pack: %s version %s license: %s" % (doc["pack"], doc["version"], doc["license"]))
if str(doc["license"]).startswith("UNRESOLVED"):
    print("NOTE: license unresolved — local-parity only, must not ship publicly.")
refs = {c for a in doc["actions"] for c in a["clips"]}
bad = sorted(r for r in refs if not safe.match(r) or ".." in r or "/" in r)
assert not bad, f"unsafe clip refs: {bad}"
print("actions: %d roles: %s fallback: %s" % (len(doc["actions"]), sorted(doc["roles"]), doc["fallback_role"]))
EOF

echo "== asset presence"
missing=0
for f in $(python3 -c "import json;print(' '.join(c for a in json.load(open('$FROM/pack.json'))['actions'] for c in a['clips']))"); do
  if [ ! -f "$FROM/$f" ]; then echo "MISSING: $f"; missing=1; fi
done
[ "$missing" -eq 0 ] && echo "all pack assets present." || { echo "refusing: incomplete asset set."; exit 1; }

if [ "$APPLY" -eq 0 ]; then
  echo "dry-run OK. Re-run with --to <dir> --apply to copy after provenance review."
  exit 0
fi
[ -n "$TO" ] || { echo "--apply needs --to <dir>" >&2; exit 2; }
mkdir -p "$TO"
cp -p "$FROM/pack.json" "$TO/pack.json"
for f in $(python3 -c "import json;print(' '.join(c for a in json.load(open('$FROM/pack.json'))['actions'] for c in a['clips']))"); do
  cp -p "$FROM/$f" "$TO/$f"
done
echo "imported into $TO. Confirm rights before any public use."
