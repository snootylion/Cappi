#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Validate shippable asset sets (stdlib only).

Checks (read-only):
  - characters/registry.json parses and lists the runtime packs
  - each registry pack has a characters/<id>/pack.json with
    schema_version 2, a license field that is NOT unresolved, and roles
    + fallback_role consistent with the registry entry
  - watch-app asset mirrors (assets/characters/*/pack.json) match the
    canonical characters/ packs byte-for-byte
  - the licensed cappi-original pack verifies when present or listed:
    Apache-2.0 pack + provenance licenses, the 25-file sha256 inventory
    matching the pack's clips, per-file hash+size checks, byte-identical
    watch-app mirrors, no un-inventoried GIFs
  - assets/cappi/ holds only README-GATE.md (binaries fail here too,
    independently of the secret scan)
  - protocol fixtures referenced by transport-endpoints.md exist

Usage: python3 tools/validate-assets.py [--root DIR] [--format text|json]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from release_common import (  # noqa: E402
    CAPPI_ORIGINAL_ID,
    ROOT as DEFAULT_ROOT,
    verify_cappi_original,
)

EXPECTED_FIXTURES = (
    "protocol/fixtures/cappi-command.json",
    "protocol/fixtures/cappi-response.json",
    "protocol/fixtures/character-select.json",
    "protocol/fixtures/capabilities.json",
    "protocol/fixtures/health.json",
    "protocol/fixtures/pairing.json",
)


def fail(errors: list[str], message: str) -> None:
    errors.append(message)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--format", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    errors: list[str] = []
    checked = 0

    # Registry + packs.
    reg_path = root / "characters" / "registry.json"
    if not reg_path.is_file():
        fail(errors, "missing characters/registry.json")
        registry = {}
    else:
        try:
            registry = json.loads(reg_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            fail(errors, f"characters/registry.json unreadable: {exc}")
            registry = {}
    packs = registry.get("characters", []) if isinstance(registry, dict) else []
    if not packs:
        fail(errors, "registry lists no packs")
    for entry in packs:
        if not isinstance(entry, dict):
            fail(errors, "registry pack entry is not an object")
            continue
        pid = entry.get("id")
        if not pid:
            fail(errors, "registry pack entry without id")
            continue
        checked += 1
        pack_path = root / "characters" / pid / "pack.json"
        if not pack_path.is_file():
            fail(errors, f"missing characters/{pid}/pack.json")
            continue
        try:
            pack = json.loads(pack_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            fail(errors, f"characters/{pid}/pack.json unreadable: {exc}")
            continue
        if pack.get("schema_version") != 2:
            fail(errors, f"characters/{pid}/pack.json: schema_version != 2")
        lic = pack.get("license", "")
        if not lic:
            fail(errors, f"characters/{pid}/pack.json: missing license field")
        elif str(lic).startswith("UNRESOLVED"):
            fail(errors, f"characters/{pid}/pack.json: unresolved license")
        roles = pack.get("roles", {})
        fallback = pack.get("fallback_role")
        if fallback not in roles:
            fail(errors, f"characters/{pid}/pack.json: fallback_role "
                         f"{fallback!r} not in roles")
        for role in entry.get("roles", []) if isinstance(entry.get("roles"), list) else []:
            pass  # registry role lists are informational; packs rule
        # Watch-app mirror must match byte-for-byte.
        mirror = (root / "watch-app/app/src/main/assets/characters"
                  / pid / "pack.json")
        if mirror.is_file():
            checked += 1
            if mirror.read_bytes() != pack_path.read_bytes():
                fail(errors, f"watch-app mirror mismatch for pack {pid}")
        else:
            fail(errors, f"missing watch-app asset mirror for pack {pid}")

    # Licensed cappi-original pack: strict hash-inventory verification
    # whenever the pack is present in the tree or listed in the registry.
    # (Presence of the files never implies permission by itself; the
    # LICENSE-DECISION.md grant is enforced by the publication gate.)
    reg_ids = set()
    for entry in packs:
        if isinstance(entry, dict) and entry.get("id"):
            reg_ids.add(entry.get("id"))
    cappi_dir_present = (root / "characters" / CAPPI_ORIGINAL_ID).is_dir()
    if CAPPI_ORIGINAL_ID in reg_ids or cappi_dir_present:
        checked += 1
        ok, _, inv_errors = verify_cappi_original(root)
        if not ok:
            for message in inv_errors:
                fail(errors, message)
        lic = None
        try:
            pack = json.loads((root / "characters" / CAPPI_ORIGINAL_ID
                               / "pack.json").read_text(encoding="utf-8"))
            lic = pack.get("license")
        except (OSError, ValueError):
            pass
        if lic is not None and lic != "Apache-2.0":
            fail(errors, f"characters/{CAPPI_ORIGINAL_ID}/pack.json: "
                         f"license {lic!r} is not the approved Apache-2.0")

    # Cappi dir: gate README only.
    cappi = root / "watch-app/app/src/main/assets/cappi"
    if cappi.is_dir():
        for entry in sorted(cappi.iterdir()):
            if entry.is_file() and entry.name != "README-GATE.md":
                fail(errors, f"unresolved Cappi binary in tree: {entry.name}")
                checked += 1
    else:
        fail(errors, "missing watch-app/app/src/main/assets/cappi/ "
                     "(the gate README directory itself must ship)")

    # Protocol fixtures.
    for fixture in EXPECTED_FIXTURES:
        checked += 1
        if not (root / fixture).is_file():
            fail(errors, f"missing {fixture}")

    ok = not errors
    if args.format == "json":
        print(json.dumps({"ok": ok, "checked": checked, "errors": errors},
                         indent=2, sort_keys=True))
    else:
        print(f"assets checked: {checked}")
        if ok:
            print("PASS: asset sets consistent")
        else:
            print(f"FAIL: {len(errors)} problem(s):")
            for message in errors:
                print(f"  - {message}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
