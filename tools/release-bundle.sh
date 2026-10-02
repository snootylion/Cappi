#!/bin/sh
# tools/release-bundle.sh — build the release candidate bundle + checksums.
#
# Default (publication path): runs the license gate first and REFUSES when
# any gate is open (legacy Cappi restores present, licensed cappi-original
# hash inventory unverified, or recorded owner approvals missing).
# Nothing is published until the gates close — see LICENSE-DECISION.md
# (project-code and imported voice-plugin source: owner-approved
# Apache-2.0, 2026-09-27).
#
#   ./tools/release-bundle.sh --local [--artifacts]
#     LOCAL candidate for packaging tests: proceeds despite open gates and
#     writes sidecar GATE-STATUS.txt (open gates listed), SBOM JSON, and a
#     LOCAL-MANIFEST.txt into dist/ next to the archive. The archive name
#     carries *-local-* so it can never be mistaken for a publication.
#     GATE-STATUS / SBOM / LOCAL-MANIFEST are SIDECARS in dist/ — they are
#     not embedded inside the source tarball (earlier docs saying
#     "embedded" were corrected here).
#     No private files are included either way (allowlist export).
#     --artifacts additionally packages a SEPARATE local-only artifact
#     bundle (generic-signed DEBUG/DEV APK + optional unsigned standard (not R8-minified) release +
#     installable plugin .tgz packs built
#     with isolated local `npm pack --ignore-scripts --offline` from the
#     already-built packages, when present) with its own checksums,
#     artifact SBOM, and binary/secret scans (nested archive members
#     included). No production signing key is generated or copied; DEBUG
#     signature is checked using apksigner, unsigned release needs owner signing.
#
# Verification: the source tree AND the actual built archive are both
# scanned (scan-secrets --root + --archive), plus asset validation and
# binary metadata inspection. Any scan failure refuses the bundle in both
# modes — secrets never ship, even locally.
#
# Outputs (gitignored dist/):
#   dist/wear-dsh-<VERSION>[-local]-source.tar.gz + .sha256
#   dist/wear-dsh-<VERSION>[-local]-sbom.json
#   dist/wear-dsh-<VERSION>[-local]-GATE-STATUS.txt
#   dist/wear-dsh-<VERSION>-local-LOCAL-MANIFEST.txt (--local only)
#   dist/wear-dsh-<VERSION>-local-artifacts.tar.gz + .sha256 + -sbom.json
#     (--local --artifacts only; verified generic DEBUG APK is required;
#     this script never runs Gradle itself; plugin packs
#     additionally land as dist/*.tgz, gitignored like all of dist/)
#   .sha256 sidecars are integrity hashes only, NOT release signatures; the
#   DEBUG APK is generic signed for fresh local installs, NOT production signed;
#   optional standard (not R8-minified) release is unsigned and requires owner signing.
#
# Safe: read-only tree, writes dist/ only. No network, no live targets.
set -eu

# Strict ambient environment allowlist BEFORE any Node/npm/SDK subprocess.
# Unknown provider/API/token/password/SSH/git/proxy variables are dropped;
# inspect NAMES only, never log values. HOME never points at the user profile.
for _env_key in $(env | cut -d= -f1); do
  case "$_env_key" in
    PATH|TMPDIR|LANG|LC_*|APKSIGNER|ANDROID_HOME|ANDROID_SDK_ROOT|JAVA_HOME) ;;
    *) unset "$_env_key" 2>/dev/null || true ;;
  esac
done
export HOME=/tmp

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCAL=0
ARTIFACTS=0

for arg in "$@"; do
  case "$arg" in
    --local) LOCAL=1 ;;
    --artifacts) ARTIFACTS=1 ;;
    -h|--help)
      echo "usage: $0 [--local] [--artifacts]" >&2
      echo "  default refuses when publication gates are open;" >&2
      echo "  --local builds a clearly-labelled local candidate instead" >&2
      echo "    (GATE-STATUS/SBOM/LOCAL-MANIFEST ship as dist/ sidecars);" >&2
      echo "  --artifacts (with --local) adds a separate DEBUG-installable /" >&2
      echo "    built-plugin artifact bundle (local only, never published)." >&2
      exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ "$ARTIFACTS" = 1 ] && [ "$LOCAL" = 0 ]; then
  echo "REFUSED: --artifacts is local-only; re-run with --local --artifacts." >&2
  exit 2
fi

# All subprocesses use a private home/cache, never ambient DSH or npmrc.
for v in $(env | cut -d= -f1 | grep -E '^(DSH_|BRIDGE_|VOICE_|LIVE_VOICE_|KOKORO_|POCKET_|NPM_CONFIG_|npm_config_|XDG_)' || true); do unset "$v" || true; done
RELEASE_HOME=$(mktemp -d "${TMPDIR:-/tmp}/wear-dsh-release-home.XXXXXX")
chmod 700 "$RELEASE_HOME"
trap 'rm -rf "$RELEASE_HOME" "${ART_STAGE:-$RELEASE_HOME/unused}" "${PACK_TMP:-$RELEASE_HOME/unused}"' EXIT INT TERM
export HOME="$RELEASE_HOME"
export NPM_CONFIG_USERCONFIG="$HOME/blank-npmrc"
export NPM_CONFIG_GLOBALCONFIG=/dev/null
export NPM_CONFIG_CACHE="$HOME/npm-cache"
: > "$NPM_CONFIG_USERCONFIG"

VERSION=$(tr -d '[:space:]' < "$ROOT/tools/VERSION")
if [ "$LOCAL" = 1 ]; then
  TAG="${VERSION}-local"
else
  TAG="$VERSION"
fi
DIST="$ROOT/dist"
mkdir -p "$DIST"

echo "== license gate (sidecar, not embedded) =="
if python3 "$ROOT/tools/check-license-gate.py" --root "$ROOT" --format text \
    > "$DIST/wear-dsh-${TAG}-GATE-STATUS.txt" 2>&1; then
  GATE="closed"
else
  GATE="open"
fi
cat "$DIST/wear-dsh-${TAG}-GATE-STATUS.txt"

if [ "$GATE" = "open" ] && [ "$LOCAL" = 0 ]; then
  echo "REFUSED: publication gates open. Re-run with --local for a local" >&2
  echo "candidate, or close the gates (see LICENSE-DECISION.md)." >&2
  exit 1
fi

echo "== source-tree scans (refuse on any finding) =="
python3 "$ROOT/tools/scan-secrets.py" --root "$ROOT"
python3 "$ROOT/tools/validate-assets.py" --root "$ROOT"
python3 "$ROOT/tools/inspect-binaries.py" --root "$ROOT"

echo "== sbom (sidecar, not embedded) =="
python3 "$ROOT/tools/sbom.py" --root "$ROOT" \
  --out "$DIST/wear-dsh-${TAG}-sbom.json"

echo "== source export =="
"$ROOT/tools/export-source.sh" \
  --out "dist/wear-dsh-${TAG}-source.tar.gz"

echo "== archive scan (actual artifact, not just the tree) =="
python3 "$ROOT/tools/scan-secrets.py" \
  --archive "$DIST/wear-dsh-${TAG}-source.tar.gz"

if [ "$LOCAL" = 1 ]; then
  echo "== local manifest (sidecar) =="
  MANIFEST="$DIST/wear-dsh-${TAG}-LOCAL-MANIFEST.txt"
  {
    echo "wear-dsh LOCAL candidate manifest"
    echo "tag: $TAG"
    echo "gates: $GATE (see GATE-STATUS sidecar; LOCAL only, NOT for publication)"
    echo "contents (dist/ sidecars + archive):"
    for f in "$DIST"/wear-dsh-"${TAG}"-source.tar.gz \
             "$DIST"/wear-dsh-"${TAG}"-source.tar.gz.sha256 \
             "$DIST"/wear-dsh-"${TAG}"-sbom.json \
             "$DIST"/wear-dsh-"${TAG}"-GATE-STATUS.txt; do
      base=$(basename "$f")
      if command -v shasum >/dev/null 2>&1; then
        sum=$(shasum -a 256 "$f" | cut -d' ' -f1)
      else
        sum=$(sha256sum "$f" | cut -d' ' -f1)
      fi
      bytes=$(wc -c < "$f" | tr -d ' ')
      echo "  $base sha256=$sum bytes=$bytes"
    done
  } > "$MANIFEST"
  cat "$MANIFEST"
fi

if [ "$ARTIFACTS" = 1 ]; then
  echo "== local artifacts bundle (DEBUG/DEV installable + optional unsigned release, local only) =="
  ART_STAGE=$(mktemp -d "${TMPDIR:-/tmp}/wear-dsh-artifacts.XXXXXX")
  # The outer cleanup trap owns this private staging directory too.
  ART_LIST="$ART_STAGE/list.txt"
  : > "$ART_LIST"
  # A fresh install needs a SIGNED APK. Only Gradle's generic DEBUG output
  # is accepted here: cryptographic verification + standard debug subject,
  # no keystore access/copy and no production signing key generation.
  apk="$ROOT/watch-app/app/build/outputs/apk/debug/app-debug.apk"
  if [ -f "$apk" ]; then
    mkdir -p "$ART_STAGE/apk"
    rel="apk/wear-dsh-${VERSION}-debug-installable.apk"
    cp "$apk" "$ART_STAGE/$rel"
    python3 "$ROOT/tools/inspect-apk.py" --apk "$ART_STAGE/$rel" \
      --out "$ART_STAGE/apk/debug-signature.json"
    cp "$ART_STAGE/$rel" "$DIST/$(basename "$rel")"
    echo "$rel" >> "$ART_LIST"
    echo 'apk/debug-signature.json' >> "$ART_LIST"
  else
    echo 'REFUSED: --artifacts requires app-debug.apk for a fresh-install DEBUG/DEV candidate (build :app:assembleDebug first)' >&2
    exit 1
  fi
  # Optional standard (not R8-minified) release is kept clearly UNSIGNED; requires the
  # owner's own signing key before installation. Never stage signed release.
  apk="$ROOT/watch-app/app/build/outputs/apk/release/app-release-unsigned.apk"
  if [ -f "$apk" ]; then
    rel="apk/wear-dsh-${VERSION}-release-unsigned.apk"
    cp "$apk" "$ART_STAGE/$rel"
    cp "$ART_STAGE/$rel" "$DIST/$(basename "$rel")"
    echo "$rel" >> "$ART_LIST"
  fi
  cat > "$ART_STAGE/ARTIFACT-PLAN.txt" <<'EOF'
LOCAL review artifacts only; no publication/upload/deployment authorization.
*-debug-installable.apk: generic Android DEBUG/DEV signature; fresh install only.
DEBUG/DEV has existing exported AvatarRenderProbeActivity/debug-renderer assets
and an in-process factory test seam. Do not claim production-hook isolation.
NOT production release signed. No claim of upgrading an original physical watch.
Future updates need the same signing key AND a suitable versionCode (currently 3).
*-release-unsigned.apk (optional): standard (not R8-minified) build; REQUIRES owner signing key.
Plugin tgz: official dsh plugin --profile web add <path>, LiveVoice then Cappi.
Native Mach-O helper is compiled inside the runtime tgz, never in source export.
No keystore, credentials, runtime consent/state, caches or model weights included.
Source SHA256 and member hashes in checksums/SBOM bind this review to its sources.
EOF
  echo 'ARTIFACT-PLAN.txt' >> "$ART_LIST"
  # Installable plugin packs: isolated local `npm pack` per package.
  # lib/ must ALREADY be built (this script never builds, installs, or
  # deploys anything). The pack runs fully local and offline
  # (--ignore-scripts so no lifecycle hook can execute, --offline so no
  # registry is contacted); the .tgz lands in gitignored dist/ and a
  # copy is staged into the bundle, where the recursive artifact scan
  # verifies every nested member (package.json, lib/, SKILL.md,
  # resources/) for secrets/paths. No models, caches, or node_modules
  # travel inside the packs (npm `files` + pack listing prove it below).
  for plug in dsh-watch dsh-live-voice; do
    if [ -f "$ROOT/plugins/$plug/package.json" ] \
        && [ -d "$ROOT/plugins/$plug/lib" ]; then
      echo "packing installable plugin: $plug (local npm pack, no scripts)"
      PACK_TMP=$(mktemp -d "${TMPDIR:-/tmp}/wear-dsh-pack.XXXXXX")
      python3 "$ROOT/tools/lib/snapshot-plugin.py" "$ROOT/plugins/$plug" "$PACK_TMP/source"
      PACK_FILE=$(cd "$PACK_TMP/source" && \
        npm pack --ignore-scripts --offline \
          --pack-destination "$PACK_TMP" 2>"$PACK_TMP/npm.log" \
          | tail -n 1) || {
        echo "REFUSED: npm pack failed for $plug (see $PACK_TMP/npm.log)" >&2
        rm -rf "$PACK_TMP"
        exit 1
      }
      [ -n "$PACK_FILE" ] && [ -f "$PACK_TMP/$PACK_FILE" ] || {
        echo "REFUSED: npm pack produced no tarball for $plug" >&2
        rm -rf "$PACK_TMP"
        exit 1
      }
      echo "  pack contents ($PACK_FILE):"
      tar -tzf "$PACK_TMP/$PACK_FILE" | sort | tee "$PACK_TMP/contents.txt"
      if grep -iE "node_modules|\.env$|/token$|\.keystore|\.pem$|\.bin$|kokoro-82M|\.gradle-home" \
          "$PACK_TMP/contents.txt" >/dev/null; then
        echo "REFUSED: forbidden entry inside $plug pack" >&2
        grep -iE "node_modules|\.env$|/token$|\.keystore|\.pem$|\.bin$|kokoro-82M|\.gradle-home" \
          "$PACK_TMP/contents.txt" >&2
        rm -rf "$PACK_TMP"
        exit 1
      fi
      cp "$PACK_TMP/$PACK_FILE" "$DIST/$PACK_FILE"
      mkdir -p "$ART_STAGE/plugins"
      cp "$PACK_TMP/$PACK_FILE" "$ART_STAGE/plugins/$PACK_FILE"
      echo "plugins/$PACK_FILE" >> "$ART_LIST"
      rm -rf "$PACK_TMP"
    else
      echo "note: skipping $plug pack (needs package.json + built lib/)"
    fi
  done
  if [ ! -s "$ART_LIST" ]; then
    echo "note: no build outputs present (no APK, no plugin packs); skipping artifacts bundle."
    echo "hint: build via docs/ONBOARDING.md + CI, then re-run with --local --artifacts."
  else
    echo "source_archive_sha256: $(shasum -a 256 "$DIST/wear-dsh-${TAG}-source.tar.gz" | cut -d' ' -f1)" >> "$ART_STAGE/ARTIFACT-PLAN.txt"
    sort -u "$ART_LIST" -o "$ART_LIST"
    (cd "$ART_STAGE" && while IFS= read -r rel; do shasum -a 256 "$rel"; done < "$ART_LIST") > "$ART_STAGE/CHECKSUMS.sha256"
    echo 'CHECKSUMS.sha256' >> "$ART_LIST"
    ART_TAR="$DIST/wear-dsh-${TAG}-artifacts.tar.gz"
    EPOCH="${SOURCE_DATE_EPOCH:-0}"
    ART_STAGE_OUT="$ART_TAR" ART_STAGE_LIST="$ART_LIST" ART_STAGE_DIR="$ART_STAGE" \
    SOURCE_EPOCH="$EPOCH" python3 - <<'PY'
import gzip, os, tarfile
stage = os.environ['ART_STAGE_DIR']
names = open(os.environ['ART_STAGE_LIST'], encoding='utf-8').read().split()
epoch = int(os.environ['SOURCE_EPOCH'])
with open(os.environ['ART_STAGE_OUT'], 'wb') as raw:
    with gzip.GzipFile(filename='', fileobj=raw, mode='wb',
                       compresslevel=9, mtime=epoch) as gz:
        with tarfile.open(fileobj=gz, mode='w',
                          format=tarfile.PAX_FORMAT) as tf:
            for rel in names:
                abs_p = os.path.join(stage, rel)
                ti = tf.gettarinfo(abs_p, rel)
                ti.uid = ti.gid = 0
                ti.uname = ti.gname = ''
                ti.mtime = epoch
                ti.pax_headers = {}
                if ti.isfile():
                    with open(abs_p, 'rb') as fh:
                        tf.addfile(ti, fh)
                else:
                    tf.addfile(ti)
PY
    if command -v shasum >/dev/null 2>&1; then
      (cd "$DIST" && shasum -a 256 "$(basename "$ART_TAR")" > "$ART_TAR.sha256")
    else
      (cd "$DIST" && sha256sum "$(basename "$ART_TAR")" > "$ART_TAR.sha256")
    fi
    echo "== artifacts scan (binary + secret metadata, values never printed) =="
    python3 "$ROOT/tools/scan-secrets.py" --archive "$ART_TAR"
    python3 "$ROOT/tools/inspect-artifacts.py" --archive "$ART_TAR" \
      --sbom-out "$DIST/wear-dsh-${TAG}-artifacts-sbom.json" || {
      echo "REFUSED: artifacts bundle failed binary/artifact checks." >&2
      exit 1
    }
    cat "$ART_TAR.sha256"
  fi
  rm -rf "$ART_STAGE"
fi

echo "== bundle contents =="
ls -la "$DIST" | grep "$TAG" || true
if [ "$LOCAL" = 1 ]; then
  echo "LOCAL candidate only (gates: $GATE) — NOT for publication."
else
  echo "Release bundle $TAG ready (gates closed)."
fi
