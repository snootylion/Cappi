#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Secret/PII/path scan for the wear-dsh release tree (stdlib only).

Reports file PATHS and per-category COUNTS only — secret values are never
printed (matches are redacted to lengths). Fails (exit 1) on any violation.
No cleanup or remediation is performed or claimed: this tool reports
findings for a human to adjudicate; it never deletes, redacts, or "cleans"
files.

Violation categories:
  filename:<rule>   forbidden committed filenames (token files, keystores,
                    .pem, .env, signing configs, logs, model weights)
  content:<rule>    forbidden content (PEM blocks, hardcoded credentials,
                    keystore passwords, absolute workstation paths
                    [macOS /Users/, Linux /home/, Windows C:\\Users\\],
                    personal email addresses, device identifiers)
  untracked-asset   private local asset restored into the tree (anything
                    but README-GATE.md under legacy assets/cappi/, or any
                    file in the licensed cappi-original dirs that is not
                    manifest-authorized + hash-verified), or any other
                    un-allowlisted binary-ish import
  symlink-escape    symlink whose resolved target leaves the tree
  unexpected-binary non-allowlisted binary archive/object outside the
                    required-binary set (the Gradle wrapper jar is
                    explicitly allowlisted — not every binary is forbidden)

Scope notes:
  - Build outputs, node_modules, .git and .release-work/ are skipped
    (skip counts reported); they are never shippable either (allowlist).
    The local Gradle cache .gradle-home/ is likewise excluded from
    content scans (gitignored at all levels) — but a cache entry that
    was accidentally STAGED (git-tracked) or packed inside a scanned
    archive is still rejected as `staged-cache`.
  - Archives (.zip/.jar/.aar/.apk/.tar.gz/.tgz) found in the tree are
    opened and their MEMBERS scanned with the same filename/content rules,
    so a secret smuggled inside an archive is still caught. The required
    gradle-wrapper.jar is opened for member listing but its own signed
    binary members are not content-scanned (allowlisted path).
  - tools/tests/ runtime fixtures live in temp dirs, never in the tree,
    so this scanner never flags its own test corpus.

Usage:
  python3 tools/scan-secrets.py [--root DIR] [--format text|json]
  python3 tools/scan-secrets.py --archive dist/bundle.tar.gz
    # scan the members of one built archive with the same rules

Safe: read-only. Opens no sockets, reads no live credentials, writes
nothing, never prints secret values.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import tarfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from release_common import (  # noqa: E402
    ARCHIVE_SUFFIXES,
    CAPPI_CANON_DIR,
    CAPPI_CANON_MIRROR_DIR,
    CAPPI_CANON_PROVENANCE,
    CONTENT_RULES,
    FILENAME_RULES,
    PLACEHOLDER_MARKERS,
    REQUIRED_BINARIES,
    ROOT as DEFAULT_ROOT,
    SKIP_DIR_NAMES,
    UNEXPECTED_BINARY_RE,
    cappi_inventory,
    is_example_email,
    is_staged_cache,
    is_synthetic_path,
    is_text_file,
    iter_source_files,
    looks_placeholder,
    sha256_file,
)

# Cappi asset dirs.
# Legacy: only the gate README may exist in a clean checkout. Restored
# private *.gif / cappi-manifest.json are local-parity only and must fail
# the scan (they are also excluded from export + .gitignored).
CAPPI_ASSET_PREFIX = "watch-app/app/src/main/assets/cappi/"
CAPPI_ALLOWED = {CAPPI_ASSET_PREFIX + "README-GATE.md"}
# Licensed: the owner-approved Apache-2.0 cappi-original pack ships ONLY
# as its manifest-authorized, hash-verified file set
# (characters/cappi-original/provenance.json inventory + identical
# watch-app mirror). A licensed GIF whose bytes match the inventory is
# authorized; anything else in those dirs (unknown GIFs, hash mismatches,
# stray files) fails as untracked-asset — no blanket GIF exemption.
CAPPI_LICENSED_PREFIXES = (CAPPI_CANON_DIR, CAPPI_CANON_MIRROR_DIR)
CAPPI_LICENSED_MANIFESTS = {"pack.json", "provenance.json"}


def load_licensed_cappi(root: Path):
    """Load the licensed Cappi sha256 inventory, or {} when absent."""
    import json as _json
    try:
        provenance = _json.loads(
            (root / CAPPI_CANON_PROVENANCE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return cappi_inventory(provenance)


def scan_licensed_cappi(rel: str, abs_p: Path, inventory: dict,
                        findings: list[Finding]) -> bool | None:
    """Rights-gate check for the licensed cappi-original dirs.

    Returns True when the file is authorized (caller continues with the
    normal rules), False when a finding was recorded (caller skips to the
    next file), None when rel is not under a licensed prefix.
    """
    if not rel.startswith(CAPPI_LICENSED_PREFIXES):
        return None
    base = rel.rsplit("/", 1)[-1]
    if base in CAPPI_LICENSED_MANIFESTS:
        return True
    want = inventory.get(base)
    if want is None or not rel.lower().endswith(".gif"):
        findings.append(Finding(
            "untracked-asset", rel,
            "file in the licensed Cappi dir is not in the sha256 "
            "inventory (only manifest-authorized assets ship)"))
        return False
    try:
        if sha256_file(abs_p).lower() != want[0].lower():
            findings.append(Finding(
                "untracked-asset", rel,
                "licensed Cappi asset hash mismatch (not the "
                "manifest-authorized bytes)"))
            return False
    except OSError:
        findings.append(Finding(
            "untracked-asset", rel,
            "licensed Cappi asset is unreadable"))
        return False
    return True

MAX_SCAN_BYTES = 1 << 20  # content-scan at most the first 1 MiB per file


class Finding:
    __slots__ = ("category", "location", "detail")

    def __init__(self, category: str, location: str, detail: str):
        self.category = category
        self.location = location
        self.detail = detail  # rule description only — never matched text


def scan_filename(rel: str, findings: list[Finding], loc: str | None = None) -> bool:
    """Apply filename rules. Returns True when the file is forbidden."""
    hit = False
    for category, pattern, description in FILENAME_RULES:
        if pattern.search(rel) or pattern.search("/" + rel):
            findings.append(
                Finding(f"filename:{category}", loc or rel, description))
            hit = True
    return hit


def scan_text(content: str, findings: list[Finding], location: str) -> None:
    for category, pattern, description in CONTENT_RULES:
        for match in pattern.finditer(content):
            if category == "token-assignment":
                # Group 2 is the assigned value; placeholders are legitimate.
                try:
                    value = match.group(2)
                except IndexError:
                    value = ""
                if looks_placeholder(value or ""):
                    continue
                # Code-expression guard: `secret = Foo.bar()` / `x = Foo(`
                # is a computed value (e.g. a test calling a `newSecret()`
                # generator), not a hardcoded credential. A real hardcoded
                # secret is a bare literal, never a qualified call/access.
                # Only `.` followed by a word char (member access) or an
                # immediate `(` (call) exempts; a sentence-ending `.`
                # followed by space/newline still flags.
                tail = content[match.end():match.end() + 2]
                if tail.startswith("(") or (
                        tail.startswith(".") and len(tail) > 1
                        and (tail[1].isalnum() or tail[1] == "_")):
                    continue
            elif category == "personal-path":
                # Strict: only the match's OWN username exempts it
                # (/Users/example/...); adjacent prose/filenames never do.
                if is_synthetic_path(match.group(0)):
                    continue
            elif category in ("linux-home-path", "windows-user-path"):
                # Strict: /home/example/..., C:\Users\example\... only.
                if is_synthetic_path(match.group(0)):
                    continue
            elif category == "email-address":
                # RFC 2606 example domains and explicit fixture markers
                # are documentation, not personal data.
                if is_example_email(match.group(0)):
                    continue
            elif category == "device-identifier":
                # IANA documentation range 00-00-5E is a synthetic fixture.
                if match.group(0).lower().startswith("00:00:5e"):
                    continue
                # Fingerprint-fragment guard: a 6-byte colon-hex run that is
                # embedded in a LONGER colon-hex run (TLS/SHA fingerprint
                # fixtures such as 'AA:BB:...:<32 bytes>') is a hash
                # fragment, not a device MAC. A real standalone MAC
                # (quoted/space-delimited, exactly 6 bytes) still flags.
                start, end = match.start(), match.end()
                continues_left = (
                    start >= 2 and content[start - 1] == ":"
                    and content[start - 2] in "0123456789abcdefABCDEF")
                continues_right = (
                    content[end:end + 1] == ":"
                    and content[end + 1:end + 2] in "0123456789abcdefABCDEF")
                if continues_left or continues_right:
                    continue
            findings.append(Finding(f"content:{category}", location, description))


def read_text_head(path: Path) -> str | None:
    try:
        with open(path, "rb") as fh:
            raw = fh.read(MAX_SCAN_BYTES)
        return raw.decode("utf-8", errors="strict")
    except (OSError, UnicodeDecodeError):
        return None


def scan_archive_members(abs_p: Path, rel: str, findings: list[Finding],
                         counts: dict) -> None:
    """Scan archive member names + text member contents with the same rules."""
    lrel = rel.lower()
    suffix = ".tar.gz" if lrel.endswith(".tar.gz") else (
        ".tgz" if lrel.endswith(".tgz") else Path(rel).suffix.lower())
    try:
        if suffix in (".zip", ".jar", ".aar", ".apk", ".aab") \
                or lrel.endswith(".zip"):
            with zipfile.ZipFile(abs_p) as zf:
                members = zf.namelist()
                counts["archive_members"] += len(members)
                for member in members:
                    if member.endswith("/"):
                        continue
                    loc = f"{rel}!{member}"
                    if is_staged_cache(member):
                        findings.append(Finding(
                            "staged-cache", loc,
                            "build-cache entry must never ship "
                            "(.gradle-home is gitignored, never staged)"))
                    scan_filename(member, findings, loc)
                    if is_text_file(Path(member)):
                        try:
                            raw = zf.read(member)[:MAX_SCAN_BYTES]
                            text = raw.decode("utf-8", errors="strict")
                        except (KeyError, UnicodeDecodeError, RuntimeError):
                            continue
                        scan_text(text, findings, loc)
        elif suffix in (".tar.gz", ".tgz"):
            with tarfile.open(abs_p, "r") as tf:
                members = tf.getmembers()
                counts["archive_members"] += len(members)
                for member in members:
                    if not member.isfile():
                        continue
                    loc = f"{rel}!{member.name}"
                    if is_staged_cache(member.name):
                        findings.append(Finding(
                            "staged-cache", loc,
                            "build-cache entry must never ship "
                            "(.gradle-home is gitignored, never staged)"))
                    scan_filename(member.name, findings, loc)
                    if is_text_file(Path(member.name)):
                        fh = tf.extractfile(member)
                        if fh is None:
                            continue
                        try:
                            text = fh.read(MAX_SCAN_BYTES).decode(
                                "utf-8", errors="strict")
                        except UnicodeDecodeError:
                            continue
                        scan_text(text, findings, loc)
    except (zipfile.BadZipFile, tarfile.TarError, OSError) as exc:
        findings.append(Finding("unreadable-archive", rel,
                                f"archive could not be opened: {type(exc).__name__}"))


def scan_root(root: Path):
    findings: list[Finding] = []
    counts = {"files": 0, "skipped_dirs": 0, "archive_members": 0,
              "archives": 0}
    licensed_cappi = load_licensed_cappi(root)
    # Count pruned top-level skip dirs for the report.
    try:
        top_entries = sorted(root.iterdir())
    except OSError:
        top_entries = []

    for rel, abs_p in iter_source_files(root):
        counts["files"] += 1

        # 1. Symlinks escaping the tree are always violations.
        if os.path.islink(abs_p):
            try:
                target = abs_p.resolve()
                target.relative_to(root.resolve())
            except (OSError, ValueError):
                findings.append(Finding(
                    "symlink-escape", rel,
                    "symlink target escapes the release tree"))
            continue

        # 2. Private Cappi restores: anything but the gate README.
        if rel.startswith(CAPPI_ASSET_PREFIX) and rel not in CAPPI_ALLOWED:
            findings.append(Finding(
                "untracked-asset", rel,
                "private Cappi parity asset must not ship "
                "(see README-GATE.md; restore locally only)"))
            continue

        # 2b. Licensed Cappi dirs: only manifest-authorized, hash-verified
        # assets pass; unknown or mismatched files fail as untracked-asset.
        licensed = scan_licensed_cappi(rel, abs_p, licensed_cappi, findings)
        if licensed is False:
            continue

        # 3. Filename rules (also catch the file itself when archived etc).
        forbidden = scan_filename(rel, findings)

        # 4. Unexpected binaries (exact allowlisted paths exempt).
        lrel = rel.lower()
        if UNEXPECTED_BINARY_RE.search(rel) and rel not in REQUIRED_BINARIES:
            findings.append(Finding(
                "unexpected-binary", rel,
                "binary not on the required-binary allowlist "
                "(gradle-wrapper.jar plus the hash-verified licensed "
                "Cappi inventory are the only shipped binaries)"))

        # 5. Archive members scanned with the same rules.
        if lrel.endswith(ARCHIVE_SUFFIXES):
            counts["archives"] += 1
            if rel not in REQUIRED_BINARIES:
                scan_archive_members(abs_p, rel, findings, counts)
            else:
                # Allowlisted binary: verify it opens, list members, no
                # content rules on signed build tooling.
                try:
                    with zipfile.ZipFile(abs_p) as zf:
                        counts["archive_members"] += len(zf.namelist())
                except (zipfile.BadZipFile, OSError):
                    findings.append(Finding("unreadable-archive", rel,
                                            "allowlisted binary is unreadable"))
            continue

        if forbidden:
            continue  # no content scan on files already rejected by name

        # 6. Content scan for text files.
        if is_text_file(abs_p):
            text = read_text_head(abs_p)
            if text is not None:
                scan_text(text, findings, rel)

    for entry in top_entries:
        if entry.is_dir() and entry.name in SKIP_DIR_NAMES:
            counts["skipped_dirs"] += 1

    # Build caches (.gradle-home) are excluded from content scans above,
    # but cache entries that were ACCIDENTALLY STAGED (git add -f) must
    # still be rejected: an ignored-but-untracked cache passes, a
    # tracked/staged one fails. Read-only `git ls-files`; skipped when
    # there is no index (fresh checkout, clean-source extract) or no git.
    if (root / ".git").is_dir() or (root / ".git").is_file():
        import subprocess as _sp
        try:
            proc = _sp.run(["git", "-C", str(root), "ls-files", "-z"],
                           capture_output=True, timeout=60)
            if proc.returncode == 0:
                for tracked in proc.stdout.split(b"\0"):
                    rel = tracked.decode("utf-8", errors="replace")
                    if rel and is_staged_cache(rel):
                        findings.append(Finding(
                            "staged-cache", rel,
                            "staged build-cache entry must never be "
                            "committed (.gradle-home is gitignored)"))
        except (OSError, ValueError):
            pass

    return findings, counts


def scan_archive_file(archive: Path):
    """Scan a single built archive (tar.gz/zip family) with the same rules.

    Used by release-bundle.sh to scan the ACTUAL shippable artifact, not
    just the source tree. Member paths are reported as
    <archive>!<member>; secret values are never printed.
    """
    findings: list[Finding] = []
    counts = {"files": 0, "skipped_dirs": 0, "archive_members": 0,
              "archives": 1}
    rel = archive.name
    scan_archive_members(archive, rel, findings, counts)
    return findings, counts


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=str(DEFAULT_ROOT))
    parser.add_argument("--archive", default=None,
                        help="scan a single archive file instead of a tree")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)

    if args.archive:
        archive = Path(args.archive)
        label = str(archive)
        findings, counts = scan_archive_file(archive)
        root = archive.resolve()
    else:
        root = Path(args.root).resolve()
        label = str(root)
        findings, counts = scan_root(root)

    by_category: dict[str, int] = {}
    for f in findings:
        by_category[f.category] = by_category.get(f.category, 0) + 1

    ok = not findings
    if args.format == "json":
        print(json.dumps({
            "ok": ok,
            "root": str(root),
            "counts": counts,
            "violations_by_category": by_category,
            "violations": [{"category": f.category, "path": f.location,
                            "rule": f.detail} for f in findings],
        }, indent=2, sort_keys=True))
    else:
        print(f"scan root : {label}")
        print(f"files scanned: {counts['files']}  "
              f"archives: {counts['archives']}  "
              f"archive members: {counts['archive_members']}  "
              f"skipped dirs: {counts['skipped_dirs']}")
        if ok:
            print("PASS: no violations (paths+counts reported, no secret values)")
        else:
            print(f"FAIL: {len(findings)} violation(s):")
            for category in sorted(by_category):
                print(f"  {category}: {by_category[category]}")
                for f in findings:
                    if f.category == category:
                        print(f"    - {f.location} [{f.detail}]")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
