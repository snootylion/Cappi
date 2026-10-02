#!/bin/sh
# tools/export-source.sh — reproducible source-allowlist export.
#
# Builds a deterministic tar.gz containing ONLY allowlisted source paths
# (tools/ALLOWLIST.txt) — never a broad tar of the workspace. Output goes
# to dist/ (gitignored) with a .sha256 sidecar.
#
# Guarantees:
#   - sorted names, fixed mtime (SOURCE_DATE_EPOCH or 0), uid/gid 0
#   - secret-named files (token, *.pem, *.keystore, .env, signing configs,
#     logs, weights) are refused even if allowlisted by accident
#   - symlinks escaping the tree are refused
#   - licensed cappi-original GIFs ship only when manifest-authorized +
#     hash-verified (provenance.json inventory); un-inventoried or
#     mismatched files refuse the export
#   - private legacy Cappi restores, node_modules, build outputs, .git and
#     .release-work/ are never included (not in the allowlist)
#
# Usage:
#   ./tools/export-source.sh [--dry-run] [--out dist/name.tar.gz]
#   ./tools/export-source.sh --list   # print the resolved file list only
#
# Output confinement: --out must stay inside dist/ (relative paths resolve
# under the tree root; absolute paths must be under $ROOT/dist). Anything
# else is refused — the toolchain never writes archives outside dist/.
#
# Safe: reads the tree, writes only dist/. No network, no live targets.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ALLOWLIST="$ROOT/tools/ALLOWLIST.txt"
OUT=""
DRY_RUN=0
LIST_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --list) LIST_ONLY=1; shift ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help)
      echo "usage: $0 [--dry-run] [--list] [--out dist/<name>.tar.gz]" >&2
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

VERSION=$(tr -d '[:space:]' < "$ROOT/tools/VERSION")
DEFAULT_OUT="dist/wear-dsh-source-${VERSION}.tar.gz"
[ -n "$OUT" ] || OUT="$DEFAULT_OUT"
# Reject newline-carrying paths (log/report injection) before resolution.
case "$OUT" in
  *"
"*) echo "export REFUSED: --out must not contain a newline" >&2; exit 2 ;;
esac
case "$OUT" in
  /*) OUT_ABS="$OUT" ;;
  *) OUT_ABS="$ROOT/$OUT" ;;
esac
# Lexical normalisation: collapse /./ and /x/../ so dist/../escape cannot
# smuggle an outside path past the prefix check (no readlink -m needed).
_NORM="$OUT_ABS"
while case "$_NORM" in *"/./"*) true;; *) false;; esac; do
  _NORM=$(printf '%s' "$_NORM" | sed 's|/\./|/|g; s|//|/|g')
done
while case "$_NORM" in *"/../"*) true;; *) false;; esac; do
  _NEXT=$(printf '%s' "$_NORM" | sed 's|/[^/]*/\.\./|/|')
  [ "$_NEXT" = "$_NORM" ] && break
  _NORM="$_NEXT"
done
OUT_ABS="$_NORM"
# Confinement: the resolved output (and its sha256 sidecar) must live under
# $ROOT/dist. Lexical canonicalisation (no symlink resolution needed: dist/
# itself is gitignored and never a symlink target we follow for writes —
# a symlinked OUT parent is refused below).
case "$OUT_ABS" in
  "$ROOT"/dist/*) ;;
  *) echo "export REFUSED: --out must stay inside dist/ (got: $OUT)" >&2; exit 2 ;;
esac
if [ -e "$OUT_ABS" ] && [ -L "$OUT_ABS" ]; then
  echo "export REFUSED: --out must not be a symlink" >&2; exit 2
fi
OUT_PARENT=$(dirname "$OUT_ABS")
if [ -e "$OUT_PARENT" ] && [ -L "$OUT_PARENT" ]; then
  echo "export REFUSED: --out parent must not be a symlink" >&2; exit 2
fi

# Portable temp file (BSD + GNU mktemp): template with XXXXXX, never -t
# without a template (GNU mktemp rejects that form, breaking Ubuntu CI).
LIST_TMP=$(mktemp "${TMPDIR:-/tmp}/export-list.XXXXXX")
trap 'rm -f "$LIST_TMP"' EXIT INT TERM
python3 - "$ROOT" "$ALLOWLIST" "$LIST_TMP" <<'PY'
import hashlib
import json as _json
import os, sys
sys.path.insert(0, os.path.join(sys.argv[1], 'tools', 'lib'))
from release_common import (load_allowlist, is_allowlisted,
                            is_forbidden_name, is_staged_cache,
                            cappi_inventory, CAPPI_CANON_DIR,
                            CAPPI_CANON_MIRROR_DIR, CAPPI_CANON_PROVENANCE,
                            SKIP_DIR_NAMES)
root, allow_path, out_path = sys.argv[1:4]

dirs, files, excepts = load_allowlist(allow_path)

selected = set()
_PRUNE = set(SKIP_DIR_NAMES) | {'.release-work'}
for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
    dirnames[:] = sorted(d for d in dirnames if d not in _PRUNE)
    for name in filenames:
        abs_p = os.path.join(dirpath, name)
        rel = os.path.relpath(abs_p, root).replace(os.sep, '/')
        if name.endswith('.pyc') or name == '.DS_Store':
            continue  # interpreter bytecode / OS residue never ships
        if is_allowlisted(rel, dirs, files, excepts):
            selected.add(rel)

# Explicit file: entries must exist (fail loudly on a stale allowlist).
missing = sorted(f for f in files
                 if not os.path.isfile(os.path.join(root, f)))
if missing:
    raise SystemExit('allowlist files missing from tree: '
                     + ', '.join(missing))

# Hard refuse: secrets, staged build caches, escaping symlinks — even if
# allowlisted.
bad = []
for rel in sorted(selected):
    abs_p = os.path.join(root, rel)
    if is_forbidden_name(rel):
        bad.append(f'secret-named: {rel}')
    if is_staged_cache(rel):
        bad.append(f'staged-cache: {rel} (.gradle-home is never staged)')
    if os.path.islink(abs_p):
        target = os.path.realpath(abs_p)
        if os.path.commonpath([target, root]) != root:
            bad.append(f'symlink-escape: {rel}')
if bad:
    raise SystemExit('export REFUSED:\n  ' + '\n  '.join(bad))

# Licensed-Cappi rights gate: files under the cappi-original dirs ship
# ONLY when manifest-authorized + hash-verified (provenance.json sha256
# inventory). Un-inventoried or mismatched files refuse the export even
# if a dir: rule covers them; the legacy assets/cappi/ dir stays fully
# excluded (only its gate README is an allowlist file entry).
_LICENSED_PREFIXES = (CAPPI_CANON_DIR, CAPPI_CANON_MIRROR_DIR)
_LICENSED_MANIFESTS = {'pack.json', 'provenance.json'}
try:
    with open(os.path.join(root, CAPPI_CANON_PROVENANCE),
              encoding='utf-8') as fh:
        _inventory = cappi_inventory(_json.load(fh))
except (OSError, ValueError):
    _inventory = {}
for rel in sorted(selected):
    if not rel.startswith(_LICENSED_PREFIXES):
        continue
    base = rel.rsplit('/', 1)[-1]
    if base in _LICENSED_MANIFESTS:
        continue
    want = _inventory.get(base)
    if want is None or not base.lower().endswith('.gif'):
        raise SystemExit(
            f'export REFUSED:\n  un-inventoried licensed-Cappi file: {rel} '
            '(only manifest-authorized assets ship)')
    digest = hashlib.sha256()
    with open(os.path.join(root, rel), 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            digest.update(chunk)
    if digest.hexdigest().lower() != want[0].lower():
        raise SystemExit(
            f'export REFUSED:\n  licensed-Cappi hash mismatch: {rel} '
            '(not the manifest-authorized bytes)')

with open(out_path, 'w', encoding='utf-8') as fh:
    for rel in sorted(selected):
        fh.write(rel + '\n')
print(f'{len(selected)} allowlisted files', file=sys.stderr)
PY

COUNT=$(wc -l < "$LIST_TMP" | tr -d ' ')
if [ "$LIST_ONLY" = 1 ]; then
  cat "$LIST_TMP"
  exit 0
fi
echo "export: $COUNT files -> $OUT" >&2

if [ "$DRY_RUN" = 1 ]; then
  echo "dry-run: archive not written." >&2
  exit 0
fi

mkdir -p "$(dirname "$OUT_ABS")"
EPOCH="${SOURCE_DATE_EPOCH:-0}"

# Deterministic archive: GNU tar when available, otherwise a stdlib
# Python builder (sorted names, fixed mtime, uid/gid 0, gzip mtime fixed).
# GNU branch: sorted-names flag in KEY=VALUE form (the concatenated single
# word spelling is rejected by GNU tar and breaks Ubuntu CI), GZIP=-n so
# the gzip header mtime stays fixed (tar's --mtime covers tar members
# only, not the gzip envelope).
if tar --version 2>/dev/null | grep -q GNU; then
  GZIP=-n tar --sort=name --mtime="@${EPOCH}" --owner=0 --group=0 --numeric-owner \
    -czf "$OUT_ABS" -C "$ROOT" -T "$LIST_TMP"
else
  EPOCH_OUT="$OUT_ABS" EPOCH_LIST="$LIST_TMP" EPOCH_ROOT="$ROOT" \
  SOURCE_EPOCH="$EPOCH" python3 - <<'PY'
import gzip, os, tarfile
root = os.environ['EPOCH_ROOT']
names = open(os.environ['EPOCH_LIST'], encoding='utf-8').read().split()
epoch = int(os.environ['SOURCE_EPOCH'])
with open(os.environ['EPOCH_OUT'], 'wb') as raw:
    with gzip.GzipFile(filename='', fileobj=raw, mode='wb',
                       compresslevel=9, mtime=epoch) as gz:
        with tarfile.open(fileobj=gz, mode='w',
                          format=tarfile.PAX_FORMAT) as tf:
            for rel in names:
                abs_p = os.path.join(root, rel)
                ti = tf.gettarinfo(abs_p, rel)
                ti.uid = ti.gid = 0
                ti.uname = ti.gname = ''
                ti.mtime = epoch
                ti.pax_headers = {}  # drop atime/ctime: atime shifts on read
                if ti.isfile():
                    with open(abs_p, 'rb') as fh:
                        tf.addfile(ti, fh)
                else:
                    tf.addfile(ti)
PY
fi

SHA_FILE="$OUT_ABS.sha256"
if command -v shasum >/dev/null 2>&1; then
  (cd "$(dirname "$OUT_ABS")" && shasum -a 256 "$(basename "$OUT_ABS")" > "$SHA_FILE")
else
  (cd "$(dirname "$OUT_ABS")" && sha256sum "$(basename "$OUT_ABS")" > "$SHA_FILE")
fi
echo "wrote $OUT_ABS"
cat "$SHA_FILE"
