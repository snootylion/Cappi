#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Binary metadata inspection for shipped assets (stdlib only).

Prints size, SHA-256 and detected type for every binary the allowlist
ships (the Gradle wrapper jar plus the hash-verified licensed Cappi
GIF inventory), plus a member listing for zip-based binaries. Used to
confirm WHAT a shipped binary is without executing anything. Licensed
Cappi GIFs verify against the characters/cappi-original/provenance.json
sha256 inventory (hash + size + watch-app mirror); any mismatch or
un-inventoried GIF fails.

Never executes the inspected files, never touches the network.

Usage: python3 tools/inspect-binaries.py [--root DIR] [--format text|json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from release_common import (  # noqa: E402
    CAPPI_CANON_DIR,
    CAPPI_CANON_MIRROR_DIR,
    ROOT as DEFAULT_ROOT,
    REQUIRED_BINARIES,
    cappi_inventory,
    is_allowlisted,
    load_allowlist,
)

MAGIC = (
    (b"PK\x03\x04", "zip (jar/aar/apk/aab/zip family)"),
    (b"\x1f\x8b", "gzip"),
    (b"%PDF", "pdf"),
    (b"\x89PNG", "png"),
    (b"GIF8", "gif"),
)


def detect_kind(head: bytes) -> str:
    for magic, label in MAGIC:
        if head.startswith(magic):
            return label
    if head.startswith(b"MZ"):
        return "pe/dos executable"
    if head[:4] in (b"\x7fELF", b"\xca\xfe\xba\xbe", b"\xcf\xfa\xed\xfe"):
        return "native executable/object"
    return "unknown/opaque binary"


def inspect(path: Path) -> dict:
    data_head = path.read_bytes()[:16]
    size = path.stat().st_size
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    info = {"path": path.as_posix(), "bytes": size,
            "sha256": digest.hexdigest(), "kind": detect_kind(data_head)}
    if data_head.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(path) as zf:
                info["members"] = len(zf.namelist())
                info["member_bytes"] = sum(i.file_size for i in zf.infolist())
        except zipfile.BadZipFile:
            info["members"] = "unreadable"
    return info


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--format", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()

    dirs, files, excepts = load_allowlist()
    targets = sorted(REQUIRED_BINARIES)
    results = []
    missing = []
    for rel in targets:
        path = root / rel
        if not path.is_file():
            missing.append(rel)
            continue
        if not is_allowlisted(rel, dirs, files, excepts):
            missing.append(f"{rel} (not allowlisted!)")
            continue
        results.append(inspect(path))

    # Licensed Cappi GIF inventory: metadata + hash/size/mirror check
    # against provenance.json. Absent pack (integration pending) is a
    # note, not a failure here — the publication gate enforces presence.
    cappi_notes = []
    prov_path = root / "characters" / "cappi-original" / "provenance.json"
    if prov_path.is_file():
        import json as _json
        try:
            inventory = cappi_inventory(
                _json.loads(prov_path.read_text(encoding="utf-8")))
        except ValueError:
            inventory = {}
            missing.append(f"{prov_path} unreadable")
        for name in sorted(inventory):
            want, want_bytes = inventory[name]
            for prefix in (CAPPI_CANON_DIR, CAPPI_CANON_MIRROR_DIR):
                rel = prefix + name
                path = root / rel
                if not path.is_file():
                    missing.append(f"{rel} (licensed Cappi asset missing)")
                    continue
                info = inspect(path)
                info["path"] = rel
                results.append(info)
                if info["sha256"].lower() != want.lower():
                    missing.append(f"{rel} (hash mismatch vs inventory)")
                elif want_bytes is not None and info["bytes"] != want_bytes:
                    missing.append(f"{rel} (size mismatch vs inventory)")
                if info["kind"] != "gif":
                    missing.append(f"{rel} (expected gif, "
                                   f"got {info['kind']})")
        for prefix in (CAPPI_CANON_DIR, CAPPI_CANON_MIRROR_DIR):
            scan_dir = root / prefix
            if scan_dir.is_dir():
                extra = sorted(
                    e.name for e in scan_dir.iterdir()
                    if e.is_file() and e.suffix.lower() == ".gif"
                    and e.name not in inventory)
                for name in extra:
                    missing.append(f"{prefix}{name} "
                                   "(un-inventoried GIF in licensed dir)")
    else:
        cappi_notes.append("no licensed Cappi pack in tree "
                           "(integration pending; gate enforces presence)")

    ok = not missing
    if args.format == "json":
        print(json.dumps({"ok": ok, "binaries": results, "missing": missing,
                          "notes": cappi_notes},
                         indent=2, sort_keys=True))
    else:
        for info in results:
            print(f"{info['path']}: {info['bytes']} bytes "
                  f"sha256={info['sha256']} kind={info['kind']}", end="")
            if "members" in info:
                print(f" members={info['members']} "
                      f"member_bytes={info.get('member_bytes')}", end="")
            print()
        for note in cappi_notes:
            print(f"note: {note}")
        if missing:
            print(f"FAIL: missing/unlisted binaries: {', '.join(missing)}")
        else:
            print(f"PASS: {len(results)} shipped binary(ies) inspected "
                  f"(metadata only, nothing executed)")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
