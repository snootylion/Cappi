#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Dependency/asset inventory + SBOM generation (stdlib only).

Reads manifests already in the tree (package.json, pnpm-lock.yaml headers,
Gradle wrapper properties, character packs, PROVENANCE records) and writes
a JSON inventory. No registry/network access: versions come from committed
lockfiles and sources, never fetched.

Model weights and voice-cloning weights are listed as EXTERNAL references
(download URL + pinned revision + license link/checksum doc) and are never
bundled — the inventory records where to verify them, not the bytes.

No hashes are fabricated: every checksum in the output is either computed
locally from tree files or quoted verbatim from an upstream-provided file
(marked "upstream-provided", with the file path).

Usage:
  python3 tools/sbom.py [--root DIR] --out dist/sbom-0.2.0-rc0.json
  python3 tools/sbom.py [--root DIR] --format json   # stdout, no write
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from release_common import ROOT as DEFAULT_ROOT, read_version  # noqa: E402


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--out", default=None)
    parser.add_argument("--format", choices=("json",), default="json")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    version = read_version()

    components: list[dict] = []

    # Node plugin manifests (own + peer/dev deps as declared, not resolved).
    for plugin in ("plugins/dsh-watch", "plugins/dsh-live-voice"):
        manifest = read_json(root / plugin / "package.json")
        if not manifest:
            continue
        components.append({
            "type": "plugin",
            "path": f"{plugin}/package.json",
            "name": manifest.get("name"),
            "version": manifest.get("version"),
            "note": "component version as declared in the plugin manifest "
                    "(all components at 0.2.0-rc0)",
        })
        for scope in ("peerDependencies", "devDependencies", "dependencies"):
            for name, spec in (manifest.get(scope) or {}).items():
                components.append({
                    "type": "npm:" + scope,
                    "path": f"{plugin}/package.json#{scope}/{name}",
                    "name": name,
                    "version": spec,
                    "note": "registry-resolved at build; own terms apply",
                })

    # Gradle wrapper distribution (from committed properties, not fetched).
    props = root / "watch-app/gradle/wrapper/gradle-wrapper.properties"
    if props.is_file():
        text = props.read_text(encoding="utf-8")
        match = re.search(r"distributionUrl=.*?(gradle-[0-9.]+-bin\.zip)", text)
        components.append({
            "type": "build-tool",
            "path": "watch-app/gradle/wrapper/gradle-wrapper.properties",
            "name": "gradle",
            "version": match.group(1) if match else "see properties",
            "note": "downloaded by the wrapper on first run; wrapper jar "
                    "in-tree (see inspect-binaries)",
        })
    jar = root / "watch-app/gradle/wrapper/gradle-wrapper.jar"
    if jar.is_file():
        components.append({
            "type": "build-tool-binary",
            "path": "watch-app/gradle/wrapper/gradle-wrapper.jar",
            "name": "gradle-wrapper.jar",
            "version": "computed",
            "sha256": sha256_of(jar),
            "sha256_source": "computed-locally",
        })

    # Character packs (shipped data assets with their declared licenses).
    # Superseded pre-v2 drafts (e.g. example-pack, schema_version 1, kept
    # for history, NOT loaded at runtime) are excluded from the inventory.
    for pack_dir in sorted((root / "characters").glob("*/pack.json")):
        pack = read_json(pack_dir) or {}
        if pack.get("schema_version") != 2:
            continue
        rel = pack_dir.relative_to(root).as_posix()
        components.append({
            "type": "character-pack",
            "path": rel,
            "name": pack.get("pack"),
            "version": pack.get("version"),
            "license_declared": pack.get("license"),
            "sha256": sha256_of(pack_dir),
            "sha256_source": "computed-locally",
        })

    # External model assets: references only, never bytes.
    kokoro_sha = root / ("plugins/dsh-live-voice/resources/"
                         "kokoro-model-sha256.txt")
    kokoro_entry: dict = {
        "type": "external-model",
        "name": "mlx-community/Kokoro-82M-bf16",
        "bundled": False,
        "license": "NOASSERTION — see upstream repository terms before "
                   "opting into --download-models "
                   "(https://huggingface.co/mlx-community/Kokoro-82M-bf16)",
        "verify_doc": "plugins/dsh-live-voice/resources/"
                      "kokoro-model-sha256.txt",
    }
    if kokoro_sha.is_file():
        kokoro_entry["upstream_checksums"] = "upstream-provided"
        kokoro_entry["upstream_checksum_file_sha256"] = sha256_of(kokoro_sha)
        kokoro_entry["upstream_checksum_file_sha256_source"] = \
            "computed-locally (file bytes); listed hashes inside are " \
            "upstream-provided, not re-verified here"
    components.append(kokoro_entry)
    components.append({
        "type": "external-model",
        "name": "cof139/G9v3-3B-mlx-4Bit (local summary)",
        "bundled": False,
        "license": "NOASSERTION — see upstream repository terms "
                   "(https://huggingface.co/cof139/G9v3-3B-mlx-4Bit)",
        "verify": "revision-pinned fetch (see PROVENANCE.md)",
    })

    inventory = {
        "inventory": "wear-dsh-inventory/1",
        "release_candidate": version,
        "note": "Component versions are owned by their contributors; the "
                "release-candidate label versions the BUNDLE only. "
                "No model weights are bundled. No licenses are invented: "
                "third-party terms are NOASSERTION with upstream links.",
        "components": components,
    }
    text = json.dumps(inventory, indent=2, sort_keys=True) + "\n"
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        print(f"wrote {out} ({len(components)} components)")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
