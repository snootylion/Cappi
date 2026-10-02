#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""License/publication gate for the wear-dsh release tree (stdlib only).

Evaluates the known publication blockers and reports a clear status.
Exit 0 means "gates closed" (shippable); exit 1 means PUBLICATION BLOCKED.

Known gates (see docs/ASSET-LICENSE-NOTES.md, LICENSE-DECISION.md):
  cappi-binaries    (a) private unrestored binaries in the legacy
                     assets/cappi/ directory (anything but README-GATE.md),
                     and (b) the licensed cappi-original hash inventory:
                     CAPPI-ORIGINAL-GRANT recorded plus
                     characters/cappi-original/provenance.json 25-file
                     sha256 inventory verifying (hashes, watch-app mirrors,
                     registry entry). The gate closes only when the legacy
                     dir is clean AND the approved inventory verifies.
  upstream-voice    imported voice-plugin source redistribution permitted
                     via the recorded UPSTREAM-VOICE-GRANT (owner-approved
                     Apache-2.0, 2026-09-27) — a real permission, never
                     invented.
  project-license   original project-code license confirmed via the
                     recorded CONFIRMED-BY-USER (owner-approved Apache-2.0,
                     2026-09-27).

A failing gate blocks PUBLICATION (release-bundle.sh without --local
refuses), but LOCAL candidate builds still proceed with an embedded
GATE-STATUS file so developers can test packaging with no private files.

Usage:
  python3 tools/check-license-gate.py [--root DIR] [--format text|json]

Safe: read-only. Opens no sockets, writes nothing.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from release_common import (  # noqa: E402
    ROOT as DEFAULT_ROOT,
    verify_cappi_original,
)

CAPPI_ASSET_DIR = Path("watch-app/app/src/main/assets/cappi")
CAPPI_ALLOWED = {"README-GATE.md"}
DECISION_FILE = Path("LICENSE-DECISION.md")

# A gate-closing record is a completed line, not the <placeholder> template:
#   UPSTREAM-VOICE-GRANT: Apache-2.0 owner-approved 2026-09-27 (real values)
#   CONFIRMED-BY-USER: Apache-2.0 owner-approved 2026-09-27 (license id +
#     owner approval + date; no personal name/email/handle required/wanted)
#   CAPPI-ORIGINAL-GRANT: Apache-2.0 owner-approved 2026-09-27 (same shape)
COMPLETED_RECORD_RE = re.compile(
    r"^(UPSTREAM-VOICE-GRANT|CONFIRMED-BY-USER|CAPPI-ORIGINAL-GRANT):"
    r"\s*([^<\s].*)$", re.MULTILINE)


def check_gates(root: Path):
    gates = []

    decision = (root / DECISION_FILE).read_text(encoding="utf-8") \
        if (root / DECISION_FILE).is_file() else ""
    completed = dict(COMPLETED_RECORD_RE.findall(decision))

    # Gate 1: Cappi. Legacy private restores always block; the licensed
    # pack closes the gate only with the recorded grant AND a verifying
    # hash inventory (hashes + mirrors + registry entry).
    cappi_dir = root / CAPPI_ASSET_DIR
    binaries: list[str] = []
    if cappi_dir.is_dir():
        for entry in sorted(cappi_dir.iterdir()):
            if entry.name not in CAPPI_ALLOWED and entry.is_file():
                binaries.append(entry.name)
    cappi_grant = "CAPPI-ORIGINAL-GRANT" in completed
    inv_ok, inv_detail, _ = verify_cappi_original(root)
    if binaries:
        gates.append({
            "id": "cappi-binaries",
            "blocked": True,
            "detail": ("private Cappi binaries present in legacy "
                       "assets/cappi/: " + ", ".join(binaries)),
        })
    elif not cappi_grant:
        gates.append({
            "id": "cappi-binaries",
            "blocked": True,
            "detail": "licensed Cappi grant not recorded "
                      "(see LICENSE-DECISION.md CAPPI-ORIGINAL-GRANT)",
        })
    elif not inv_ok:
        gates.append({
            "id": "cappi-binaries",
            "blocked": True,
            "detail": f"licensed Cappi inventory unverified: {inv_detail}",
        })
    else:
        gates.append({
            "id": "cappi-binaries",
            "blocked": False,
            "detail": f"legacy assets/cappi/ clean; {inv_detail}",
        })

    # Gate 2: imported voice-plugin source — real recorded permission.
    upstream_grant = "UPSTREAM-VOICE-GRANT" in completed
    gates.append({
        "id": "upstream-voice",
        "blocked": not upstream_grant,
        "detail": "imported voice-plugin source redistribution permitted "
                  "(owner-approved Apache-2.0 recorded)"
        if upstream_grant
        else "NOASSERTION: upstream voice code license not explicitly "
             "granted (see LICENSE-DECISION.md)",
    })

    # Gate 3: project-code license confirmation.
    confirmed = "CONFIRMED-BY-USER" in completed
    gates.append({
        "id": "project-license",
        "blocked": not confirmed,
        "detail": "project code license confirmed by user "
                  "(owner-approved Apache-2.0 recorded)"
        if confirmed
        else "no confirmed project-code license "
             "(see LICENSE-DECISION.md)",
    })

    return gates


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--format", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()

    gates = check_gates(root)
    blocked = [g for g in gates if g["blocked"]]

    if args.format == "json":
        print(json.dumps({"blocked": bool(blocked), "gates": gates},
                         indent=2, sort_keys=True))
    else:
        for g in gates:
            mark = "BLOCKED" if g["blocked"] else "closed "
            print(f"[{mark}] {g['id']}: {g['detail']}")
        if blocked:
            print(f"PUBLICATION BLOCKED: {len(blocked)} gate(s) open "
                  f"(LOCAL candidate builds still allowed with --local).")
        else:
            print("All publication gates closed.")
    return 1 if blocked else 0


if __name__ == "__main__":
    raise SystemExit(main())
