"""Shared helpers for wear-dsh release tooling (stdlib only).
SPDX-License-Identifier: Apache-2.0

Nothing here touches the network, a live DSH installation, or the real
$HOME. All tools operate on an explicit --root (default: the release tree
containing this file) and report paths, never secret values.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent  # tools/lib/
TOOLS_DIR = HERE.parent  # tools/
ROOT = TOOLS_DIR.parent  # release tree root

VERSION_FILE = TOOLS_DIR / "VERSION"
ALLOWLIST_FILE = TOOLS_DIR / "ALLOWLIST.txt"


# Licensed Cappi pack ("cappi-original"): canonical owner-approved Apache-2.0
# pack integrated separately as characters/cappi-original/pack.json with a
# 25-GIF per-file sha256 inventory, mirrored byte-for-byte at
# watch-app/app/src/main/assets/characters/cappi-original/ and listed in
# characters/registry.json. Only the manifest-authorized, hash-verified
# file set may ship or stage: arbitrary restores in the legacy
# assets/cappi/ directory and unknown binaries elsewhere stay blocked.
# The grant itself is recorded in LICENSE-DECISION.md
# (CAPPI-ORIGINAL-GRANT, owner-approved 2026-09-27).
CAPPI_ORIGINAL_ID = "cappi-original"
CAPPI_ORIGINAL_EXPECTED_FILES = 25
CAPPI_CANON_PACK = "characters/cappi-original/pack.json"
CAPPI_CANON_PROVENANCE = "characters/cappi-original/provenance.json"
CAPPI_CANON_MIRROR_PACK = ("watch-app/app/src/main/assets/characters/"
                           "cappi-original/pack.json")
CAPPI_CANON_MIRROR_PROVENANCE = ("watch-app/app/src/main/assets/characters/"
                                 "cappi-original/provenance.json")
CAPPI_CANON_DIR = "characters/cappi-original/"
CAPPI_CANON_MIRROR_DIR = ("watch-app/app/src/main/assets/characters/"
                          "cappi-original/")

_SHA256_HEX_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def _is_sha256_hex(value) -> bool:
    return isinstance(value, str) and bool(_SHA256_HEX_RE.match(value.strip()))


def cappi_inventory(provenance) -> dict:
    """Collect {gif_filename: (sha256_hex, bytes)} from a provenance object.

    Canonical shape is the `files` map in
    `characters/cappi-original/provenance.json`:
      {"files": {"<name>.gif": {"sha256": "<64-hex>", "bytes": N}, ...}}.
    A bare 64-hex string value is also accepted for forward compatibility.
    Only *.gif keys with a valid digest are returned; anything else is
    ignored here (and fails the count check downstream).
    """
    found: dict = {}
    if not isinstance(provenance, dict):
        return found
    section = provenance.get("files")
    if not isinstance(section, dict):
        return found
    for name, value in section.items():
        if not isinstance(name, str) or not name.lower().endswith(".gif"):
            continue
        base = os.path.basename(name)
        if _is_sha256_hex(value):
            found[base] = (value.strip().lower(), None)
        elif isinstance(value, dict):
            digest = value.get("sha256", value.get("hash", ""))
            size = value.get("bytes", value.get("size"))
            if _is_sha256_hex(digest):
                found[base] = (digest.strip().lower(), size)
    return found


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_cappi_original(root: Path):
    """Verify the licensed cappi-original hash inventory (read-only).

    Returns (ok, detail, errors). ok is True only when every condition
    holds: pack.json and provenance.json parse with license Apache-2.0;
    provenance.json carries the 25-file sha256 inventory matching the
    pack's clips; each listed GIF exists under characters/cappi-original/
    with matching digest+size; each has a byte-identical mirror under the
    watch-app assets directory (no un-inventoried GIFs in either dir);
    pack.json and provenance.json mirrors match; and
    characters/registry.json lists cappi-original. Anything else —
    missing pack/provenance (integration pending), unknown/missing
    license, count or hash mismatch, mirror drift — returns ok False with
    actionable errors. No licenses are invented: presence of the files
    alone never implies permission; the LICENSE-DECISION.md grant is
    checked by the publication gate, not here.
    """
    root = Path(root)
    errors: list = []
    pack_path = root / CAPPI_CANON_PACK
    prov_path = root / CAPPI_CANON_PROVENANCE
    if not pack_path.is_file():
        return (False, "licensed Cappi pack missing: "
                f"{CAPPI_CANON_PACK} not in tree (integration pending)",
                [f"missing {CAPPI_CANON_PACK}"])
    if not prov_path.is_file():
        return (False, "licensed Cappi provenance missing: "
                f"{CAPPI_CANON_PROVENANCE} not in tree (integration pending)",
                [f"missing {CAPPI_CANON_PROVENANCE}"])
    try:
        pack = json.loads(pack_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return (False, f"licensed Cappi pack unreadable: {exc}",
                [f"{CAPPI_CANON_PACK} unreadable: {exc}"])
    try:
        provenance = json.loads(prov_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return (False, f"licensed Cappi provenance unreadable: {exc}",
                [f"{CAPPI_CANON_PROVENANCE} unreadable: {exc}"])
    pack_lic = pack.get("license", "") if isinstance(pack, dict) else ""
    if pack_lic != "Apache-2.0":
        errors.append(f"{CAPPI_CANON_PACK}: license {pack_lic!r} is not "
                      "the approved Apache-2.0")
    prov_lic = provenance.get("license", "") \
        if isinstance(provenance, dict) else ""
    if prov_lic != "Apache-2.0":
        errors.append(f"{CAPPI_CANON_PROVENANCE}: license {prov_lic!r} "
                      "is not the approved Apache-2.0")
    inventory = cappi_inventory(provenance)
    if len(inventory) != CAPPI_ORIGINAL_EXPECTED_FILES:
        errors.append(
            f"{CAPPI_CANON_PROVENANCE}: inventory lists {len(inventory)} GIF "
            f"file(s), expected {CAPPI_ORIGINAL_EXPECTED_FILES} with "
            "per-file sha256")
    # The pack's clips must reference exactly the inventoried GIF set.
    clips = pack.get("clips", {}) if isinstance(pack, dict) else {}
    clip_names = {os.path.basename(k) for k in clips} \
        if isinstance(clips, dict) else set()
    if clip_names != set(inventory):
        errors.append(
            f"{CAPPI_CANON_PACK}: clips reference "
            f"{sorted(clip_names - set(inventory))[:3]}"
            f"{'...' if len(clip_names - set(inventory)) > 3 else ''} "
            "not in the sha256 inventory"
            if clip_names - set(inventory) else
            f"{CAPPI_CANON_PACK}: sha256 inventory lists "
            f"{sorted(set(inventory) - clip_names)[:3]} not referenced "
            "by clips")
    for name in sorted(inventory):
        want, want_bytes = inventory[name]
        canon = root / CAPPI_CANON_DIR / name
        mirror = root / CAPPI_CANON_MIRROR_DIR / name
        if not canon.is_file():
            errors.append(f"licensed Cappi asset missing: "
                          f"{CAPPI_CANON_DIR}{name}")
            continue
        try:
            got = sha256_file(canon)
        except OSError as exc:
            errors.append(f"licensed Cappi asset unreadable: "
                          f"{CAPPI_CANON_DIR}{name}: {exc}")
            continue
        if got.lower() != want.lower():
            errors.append(f"licensed Cappi asset hash mismatch: "
                          f"{CAPPI_CANON_DIR}{name}")
        if want_bytes is not None and canon.stat().st_size != want_bytes:
            errors.append(f"licensed Cappi asset size mismatch: "
                          f"{CAPPI_CANON_DIR}{name}")
        if not mirror.is_file():
            errors.append(f"licensed Cappi mirror missing: "
                          f"{CAPPI_CANON_MIRROR_DIR}{name}")
        elif mirror.read_bytes() != canon.read_bytes():
            errors.append(f"licensed Cappi mirror mismatch: "
                          f"{CAPPI_CANON_MIRROR_DIR}{name}")
    # No extra GIFs beyond the inventory may stage in either directory.
    for label, prefix in (("canonical", CAPPI_CANON_DIR),
                          ("mirror", CAPPI_CANON_MIRROR_DIR)):
        scan_dir = root / prefix
        if scan_dir.is_dir():
            extra = sorted(
                e.name for e in scan_dir.iterdir()
                if e.is_file() and e.suffix.lower() == ".gif"
                and e.name not in inventory)
            if extra:
                errors.append(f"licensed Cappi {label} dir holds "
                              f"un-inventoried GIF(s): {', '.join(extra[:3])}"
                              f"{'...' if len(extra) > 3 else ''}")
    mirror_pack = root / CAPPI_CANON_MIRROR_PACK
    if not mirror_pack.is_file():
        errors.append(f"missing watch-app asset mirror: {CAPPI_CANON_MIRROR_PACK}")
    elif mirror_pack.read_bytes() != pack_path.read_bytes():
        errors.append(f"watch-app mirror mismatch for pack {CAPPI_ORIGINAL_ID}")
    mirror_prov = root / CAPPI_CANON_MIRROR_PROVENANCE
    if not mirror_prov.is_file():
        errors.append(f"missing watch-app provenance mirror: "
                      f"{CAPPI_CANON_MIRROR_PROVENANCE}")
    elif mirror_prov.read_bytes() != prov_path.read_bytes():
        errors.append(f"watch-app provenance mirror mismatch for pack "
                      f"{CAPPI_ORIGINAL_ID}")
    reg_path = root / "characters" / "registry.json"
    try:
        registry = json.loads(reg_path.read_text(encoding="utf-8"))
        ids = [e.get("id") for e in registry.get("characters", [])
               if isinstance(e, dict)]
    except (OSError, ValueError, AttributeError):
        ids = []
    if CAPPI_ORIGINAL_ID not in ids:
        errors.append("registry.json does not list cappi-original")
    if errors:
        return (False, "licensed Cappi inventory invalid "
                f"({len(errors)} problem(s))", errors)
    return (True, f"licensed Cappi pack verified "
            f"({CAPPI_ORIGINAL_EXPECTED_FILES} GIF files, hashes + "
            "mirrors match, registry lists cappi-original)", [])


def read_version() -> str:
    """Release-candidate label, e.g. ``0.2.0-rc0``.

    This labels the release bundle, currently matching all component
    versions (watch-app, both plugins); see LICENSE-DECISION.md.
    """
    return VERSION_FILE.read_text(encoding="utf-8").strip()


def load_allowlist(path=ALLOWLIST_FILE):
    """Parse ALLOWLIST.txt into (dir_prefixes, exact_files, except_prefixes)."""
    dirs, files, excepts = [], [], []
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        kind, _, value = line.partition(":")
        value = value.strip()
        if kind == "dir":
            dirs.append(value)
        elif kind == "file":
            files.append(value)
        elif kind == "except":
            excepts.append(value)
        else:
            raise ValueError(f"bad allowlist rule: {raw!r}")
    return dirs, files, excepts


def is_allowlisted(rel: str, dirs, files, excepts) -> bool:
    """True when POSIX relative path rel is covered by the allowlist.

    Explicit file: entries win over except: prefixes (this is how the
    single gate-README inside the otherwise-excluded cappi asset dir, and
    the required gradle-wrapper.jar, stay shippable).
    """
    rel = rel.replace(os.sep, "/")
    if rel in files:
        return True
    for exc in excepts:
        if rel == exc.rstrip("/") or rel.startswith(exc):
            return False
    return any(rel == d.rstrip("/") or rel.startswith(d) for d in dirs)


# Directories never scanned for content (build outputs, vendored deps,
# VCS metadata). They are still excluded from exports by the allowlist.
# .gradle-home is the local Gradle cache created by prior validation runs
# (it can exceed 1 GB); it is gitignored at all levels and never ships.
SKIP_DIR_NAMES = {
    ".git", ".gradle", ".gradle-home", ".kotlin", ".pnpm-store", ".venv",
    "venv", "node_modules", "build", "out", "dist", ".idea",
    "__pycache__",
}

# Filename rules: (category, compiled pattern, description). Matched paths
# are reported as violations — secret values are never printed.
FILENAME_RULES = [
    ("token-file", re.compile(r"(^|/)(token|\.credentials\.yaml)$"),
     "credential/token file must never be committed"),
    ("signing-material", re.compile(r"\.(keystore|jks|p12|pem)$"),
     "signing/key material must never be committed"),
    ("env-secret", re.compile(r"(^|/)(\.env(\..*)?|local\.properties|release-signing\.properties)$"),
     "env/signing config must never be committed"),
    ("log-transcript", re.compile(r"\.(log|jsonl|wav|mp3|m4a)$"),
     "logs/recordings/transcripts must never be committed"),
    ("model-weight", re.compile(r"\.(bin|safetensors|onnx|mlmodelc|mlpackage)$"),
     "model weights are never vendored (fetched at install, see PROVENANCE)"),
]

# Required shippable binaries: exact tree-relative paths that are allowed
# despite looking like binaries. The Gradle wrapper jar is build tooling
# the wrapper needs; it is NOT a secret, weight, or private asset.
REQUIRED_BINARIES = {
    "watch-app/gradle/wrapper/gradle-wrapper.jar",
}

# Binary extensions that are unexpected anywhere else in source.
UNEXPECTED_BINARY_RE = re.compile(
    r"\.(jar|aar|apk|aab|so|dylib|dex|zip|tar\.gz|tgz)$", re.IGNORECASE)

# Content rules: (category, pattern, description). Only the file path and
# the count are reported — matched text is NEVER echoed (see redact()).
CONTENT_RULES = [
    ("private-key-block",
     re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
     "PEM private key block"),
    ("token-assignment",
     re.compile(r"(?i)\b(BRIDGE_TOKEN|DSH_WATCH_BRIDGE_TOKEN|API_KEY|SECRET|PASSWORD)\b\s*[:=]\s*['\"]?([A-Za-z0-9_\-/+]{16,})['\"]?"),
     "hardcoded credential-looking assignment (length>=16)"),
    ("keystore-ref",
     re.compile(r"(?i)\b(storePassword|keyPassword)\b\s*[:=]\s*['\"]?\S+['\"]?"),
     "keystore password reference"),
    ("personal-path",
     re.compile(r"/Users/[A-Za-z0-9_.-]+/"),
     "absolute personal workstation path (macOS /Users/)"),
    ("linux-home-path",
     re.compile(r"/home/[A-Za-z0-9_.-]+/"),
     "absolute personal workstation path (Linux /home/)"),
    ("windows-user-path",
     re.compile(r"(?i)C:[\\/]Users[\\/][^\\/:*?\"<>|\s]+"),
     "absolute personal workstation path (Windows C:\\Users\\)"),
    ("email-address",
     re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
     "possible personal email address"),
    ("device-identifier",
     re.compile(r"(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}|\bIMEI\s*[:=]?\s*\d{14,15}\b"),
     "possible device identifier (MAC/IMEI)"),
]

# Placeholder values that are documentation/test fixtures, not secrets.
# A token-assignment match whose value contains one of these markers
# (case-insensitive) is accepted as a legitimate synthetic placeholder.
# The same markers exempt synthetic workstation paths and documentation
# email addresses (RFC 2606 example domains, .test/.invalid, explicit
# fixture usernames) from the privacy rules.
PLACEHOLDER_MARKERS = (
    "example", "placeholder", "changeme", "dummy", "synthetic",
    "test-fixture", "test_fixture", "testfixture", "fixture",
    "rfc5737", "192.0.2.", "198.51.100.", "203.0.113.",
    "127.0.0.1", "localhost", "<", "xxx", "***",
    ".test", ".invalid", ".example",
)

# Strict per-match synthetic usernames for workstation-path exemption.
# Only the matched path's OWN username component may exempt it, by exact
# (case-insensitive) equality. Adjacent prose, variable names, fixture
# filenames (including model fixtures named "synthetic"), or broad
# substrings elsewhere NEVER exempt an unrelated real path. The generic
# username "user" is NOT synthetic (a "/Users/" + "user/" style path
# must still fail).
SYNTHETIC_USERNAMES = frozenset({
    "example", "placeholder", "test", "testuser", "test-user",
    "testfixture", "test-fixture", "test_fixture",
    "fixture", "dummy", "changeme", "synthetic",
})


def _matched_username(matched: str) -> str:
    low = matched.lower()
    if low.startswith("/users/") or low.startswith("/home/"):
        parts = matched.strip("/").split("/")
        if len(parts) >= 2:
            return parts[1].lower()
        return ""
    m = re.search(r"Users[\\/]+([^\\/:*?\"<>|\s]+)",
                  matched, re.IGNORECASE)
    if m:
        return m.group(1).lower().rstrip("/\\")
    return ""


def is_synthetic_path(matched: str) -> bool:
    """True only when the path match's OWN username is explicitly synthetic."""
    return _matched_username(matched) in SYNTHETIC_USERNAMES


# Documentation domains that are never personal email, per RFC 2606 +
# conventional test domains. An email-address match in one of these
# domains is a synthetic fixture, not a violation.
EXAMPLE_EMAIL_DOMAINS = (
    "example.com", "example.org", "example.net",
    "test.example", "example.test", "mail.example",
)


def is_example_email(value: str) -> bool:
    """True when an email match is a documentation/test fixture."""
    v = value.strip().lower()
    if looks_placeholder(v):
        return True
    domain = v.rsplit("@", 1)[-1] if "@" in v else ""
    if not domain:
        return True
    if domain in EXAMPLE_EMAIL_DOMAINS:
        return True
    return domain.endswith((".test", ".invalid", ".example"))

TEXT_SUFFIXES = {
    ".mjs", ".js", ".ts", ".tsx", ".json", ".yml", ".yaml", ".md",
    ".sh", ".swift", ".py", ".kt", ".java", ".xml", ".gradle",
    ".properties", ".txt", ".html", ".css", ".c", ".h", ".pl",
}

ARCHIVE_SUFFIXES = (".zip", ".jar", ".aar", ".apk", ".aab", ".tar.gz", ".tgz")


# Build-cache paths that must never ship: even if an allowlist rule or an
# accidental `git add -f` stages them, the export backstop and the archive
# scan refuse them. (Tree content scans skip these dirs via SKIP_DIR_NAMES;
# that exclusion is for scan scope only — staged cache is still rejected
# at the publication boundary.)
STAGED_CACHE_RE = re.compile(r"(^|/)\.gradle-home(/|$)")


def is_staged_cache(rel: str) -> bool:
    """True when a tree-relative path is a build-cache entry (.gradle-home)."""
    return bool(STAGED_CACHE_RE.search(rel.replace(os.sep, "/")))


# Secret-named files: refused by export even if an allowlist dir would
# otherwise cover them (the backstop behind .gitignore + the secret scan).
# Private execution reports (REPORT-*.md packaging notes) are likewise
# never shippable: they live in sibling .release-work/, never in the tree.
FORBIDDEN_NAME_RE = re.compile(
    r"(^|/)REPORT-[^/]*\.md$|"
    r"(^|/)(token|\.credentials\.yaml|\.env(\..*)?|local\.properties|"
    r"release-signing\.properties)$|\.(keystore|jks|p12|pem|bin|safetensors|"
    r"onnx|log|jsonl|wav|mp3|m4a|apk|aab)$", re.IGNORECASE)


def is_forbidden_name(rel: str) -> bool:
    """True when a tree-relative path must never ship (secret/weight/log)."""
    return bool(FORBIDDEN_NAME_RE.search("/" + rel.replace(os.sep, "/")))


def redact_value(text: str, match: re.Match) -> str:
    """Return a redacted rendering of a match for debugging (length only)."""
    groups = [g for g in match.groups() if g]
    longest = max((len(g) for g in groups), default=len(match.group(0)))
    return f"<redacted len={longest}>"


def looks_placeholder(value: str) -> bool:
    v = value.lower()
    return any(m in v for m in PLACEHOLDER_MARKERS)


def is_text_file(path: Path) -> bool:
    name = path.name.lower()
    if name.endswith(".tar.gz"):
        return False
    suffix = path.suffix.lower()
    if path.suffixes[-2:] == [".tar", ".gz"]:
        return False
    return suffix in TEXT_SUFFIXES or suffix == ""


def iter_source_files(root: Path):
    """Yield (relative_posix, absolute_path) for scannable tree files.

    Skips SKIP_DIR_NAMES, .release-work (private staging), and symlinked
    directories (reported separately as violations when escaping).
    """
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        # Prune in place so os.walk does not descend.
        dirnames[:] = sorted(
            d for d in dirnames
            if d not in SKIP_DIR_NAMES and d != ".release-work"
            and not os.path.islink(os.path.join(dirpath, d))
        )
        for name in sorted(filenames):
            abs_p = Path(dirpath) / name
            rel = abs_p.relative_to(root).as_posix()
            yield rel, abs_p
