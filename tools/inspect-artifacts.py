#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Artifact-bundle inspection for local unsigned builds (stdlib only).

Scans a built --artifacts tarball (unsigned RELEASE APK + installable
plugin .tgz packs) for binary/artifact hygiene WITHOUT executing anything
and writes a reproducible artifact SBOM (sorted members, per-member
sha256).

The scan RECURSES into nested archives (zip/APK/AAR/JAR family and
tar/tgz family, e.g. a plugin .tgz packed inside the bundle, or an APK
inside the bundle) under explicit bounds (depth, member count, expanded
bytes). Nested members are inventoried with `!`-joined paths
(`bundle!plugins/x.tgz!package/lib/index.js`) and scanned with the same
rules.

Refusals (exit 1, paths + counts only — values never printed):
  - absolute member paths or `..` escapes (unsafe tar/zip layout),
    including tar symlinks/hardlinks whose target escapes the archive
  - local absolute paths inside text members (/Users/, /home/,
    C:\\Users\\) — would embed one machine's layout into a bundle
  - absolute sourceMappingURL / sources entries (local sourcemap paths)
  - credential-looking assignments (BRIDGE_TOKEN=... long values,
    API_KEY/SECRET/PASSWORD) inside text members
  - secret-named members (*.pem, *.keystore, token files, .env)
  - staged build-cache members (.gradle-home) packed into the bundle
  - oversize members / text beyond the scan window: a member too large
    to scan is REJECTED (oversize-unscannable / unscannable-truncated),
    never silently blessed

Placeholder policy (strict per-match): a path finding is exempted only
when the MATCHED PATH's OWN username component is explicitly synthetic
(exact allowlist: example/placeholder/test-fixture/...). Adjacent prose,
variable names, fixture filenames, or broad substrings elsewhere on the
same line NEVER exempt a match, so a minified single-line bundle with a
placeholder beside a real path still fails on the real path. (Earlier
revisions exempted whole files, then a +/-120 char same-line window;
both over-broad exemptions are gone.)

Binary-string policy (bounded false positives): binary members are NEVER
decoded wholesale as UTF-8 — arbitrary bytes misread as text caused
excessive false positives. Instead:
  - members that decode cleanly as UTF-8 are scanned as text;
  - app code/resource carriers (classes*.dex, *.arsc, AndroidManifest.xml,
    res/*, assets/*) additionally get printable-string extraction (ASCII
    runs >= 8 chars plus UTF-16LE runs, e.g. AXML/arsc string pools) and
    the extracted runs are scanned for user paths/credentials;
  - opaque third-party binary (native .so, images, META-INF signatures,
    profiles) is listed + hashed only — its bytes are not string-mined.
Rationale: our paths/keys would live in app code and resources; mining
every third-party .so byte-run flags SDK-internal noise, so the boundary
is explicit and documented here rather than hidden in a threshold.

Native-helper policy (turnkey macOS plugin tgz): a Mach-O binary is NEVER
covered by the opaque blanket above. Mach-O members (magic FE ED FA CE /
FE ED FA CF / CF FA ED FE / CA FE BA BE / CA FE BA BF, either endian) are
allowed ONLY when the member path is an explicitly listed native helper
(see NATIVE_BIN_ALLOWLIST_SUFFIXES: compiled watch-ASR / voice-input
helpers under package/bin/); anything else fails as `unknown-binary`.
Allowed helpers are printable-string scanned (same user-path/credential
rules; values never printed) and their Mach-O arch is recorded in the
SBOM note when detectable (arm64/x86_64/fat) — provenance without
executing anything. Signing is NOT verified here (local unsigned builds
only; .sha256 sidecars are integrity hashes, never release signatures).

No signing key is generated here; the APK stays unsigned without
external signing config. Deterministic output: members sorted, JSON
keys sorted.

Usage:
  python3 tools/inspect-artifacts.py --archive dist/*-artifacts.tar.gz \
      --sbom-out dist/*-artifacts-sbom.json
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import tarfile
import zipfile
from pathlib import Path

# --------------------------------------------------------------------------
# Finding patterns (values are never printed — only paths + counts).

ABS_USER_PATH_RE = re.compile(
    r"/Users/[A-Za-z0-9_.-]+/|/home/[A-Za-z0-9_.-]+/|"
    r"C:[\\/]Users[\\/][^\\/:*?\"<>|\s]+", re.IGNORECASE)
SOURCEMAP_ABS_RE = re.compile(
    r"sourceMappingURL\s*=\s*/|\"sources\"\s*:\s*\[[^\]]*\"/(?![nrt])")
TOKEN_ASSIGN_RE = re.compile(
    r"(?i)\b(BRIDGE_TOKEN|DSH_WATCH_BRIDGE_TOKEN|API_KEY|SECRET|PASSWORD)\b"
    r"\s*[:=]\s*['\"]?([A-Za-z0-9_\-/+]{16,})['\"]?")
PLACEHOLDER_MARKERS = (
    "example", "placeholder", "changeme", "dummy", "synthetic",
    "test-fixture", "test_fixture", "testfixture", "fixture",
    "rfc5737", "192.0.2.", "198.51.100.", "203.0.113.",
    "127.0.0.1", "localhost", "<", "xxx", "***",
    ".test", ".invalid", ".example",
)
# Strict per-match synthetic usernames for workstation-path exemption.
# Only the matched path's OWN username component may exempt it, by exact
# (case-insensitive) equality against this set. Adjacent prose, variable
# names, filenames, or broad substrings elsewhere on the line NEVER exempt
# a match. Notably the generic username "user" is NOT synthetic (a
# "/Users/" + "user/" style path must still fail); a model fixture
# filename containing "synthetic" elsewhere must not exempt an
# unrelated real path.
SYNTHETIC_USERNAMES = frozenset({
    "example", "placeholder", "test", "testuser", "test-user",
    "testfixture", "test-fixture", "test_fixture",
    "fixture", "dummy", "changeme", "synthetic",
})
SECRET_NAME_RE = re.compile(
    r"(^|/)(token|\.credentials\.yaml|\.env(\..*)?|local\.properties|"
    r"release-signing\.properties)$|\.(keystore|jks|p12|pem)$",
    re.IGNORECASE)
STAGED_CACHE_RE = re.compile(r"(^|/)\.gradle-home(/|$)")

TEXT_SUFFIXES = {
    ".js", ".cjs", ".mjs", ".map", ".json", ".txt", ".md", ".yml",
    ".yaml", ".xml", ".html", ".css", ".ts", ".properties",
}

# --------------------------------------------------------------------------
# Recursion / size bounds. A bundle that exceeds any bound is REJECTED,
# never partially blessed.

MAX_DEPTH = 4                 # nested-archive recursion depth
MAX_MEMBERS_TOTAL = 20000     # total file members inspected per bundle
MAX_MEMBER_BYTES = 64 << 20   # largest single decompressed member held
MAX_TEXT_BYTES = 8 << 20      # largest text unit scanned whole
MAX_TOTAL_BYTES = 256 << 20   # total decompressed bytes inspected

EXEMPT_WINDOW = 120             # chars of context around a match for the
                              # placeholder exemption (match-local only)

# Printable-string extraction for app code/resource carriers.
ASCII_RUN_RE = re.compile(rb"[\t\n\r -~]{8,}")
UTF16LE_RUN_RE = re.compile(rb"(?:[ -~]\x00){8,}")
STRING_SCAN_NAME_RE = re.compile(
    r"(^|/)(classes[0-9]*\.dex|androidmanifest\.xml)$"
    r"|(^|/)(res|assets)/"
    r"|\.arsc$",
    re.IGNORECASE)

# Turnkey native-helper allowlist: ONLY these archive-member suffixes may
# carry a Mach-O binary (compiled watch-ASR / voice-input helpers shipped
# inside the macOS plugin tgz — V layout is `package/resources/bin/`,
# kept alongside the legacy `package/bin/` form; either suffix matches).
# No blanket Mach-O pass: any other Mach-O member fails as
# `unknown-binary`. Helpers are generated at pack time (never committed
# weights/cache state. When bundled, dist is MANDATORY for clean-install
# (no runtime CLT compile); when absent, installers fall back to consented
# compile with --apply (dry-run first). Allowlisted helpers get their arch
# parsed from the Mach-O header itself (`parse_macho_arch`: thin cputype /
# FAT slice walk — never a basename claim, never an untrusted manifest
# string) and the parsed arch is recorded per member (`arch`); a manifest
# that claims `universal` for a thin payload, or an arch list that does not
# equal the parsed payload, is a hard manifest-vs-payload mismatch (checked
# by the vanilla-install harness, which owns the manifest truth).
NATIVE_BIN_ALLOWLIST_SUFFIXES = ("package/resources/bin/watch-asr",)

# Mach-O magic (first 4 bytes): 32/64-bit LE/BE + FAT/FAT64.
MACHO_MAGICS = frozenset({
    b"\xce\xfa\xed\xfe",  # MH_MAGIC (32-bit LE)
    b"\xcf\xfa\xed\xfe",  # MH_MAGIC_64 (64-bit LE)
    b"\xfe\xed\xfa\xce",  # MH_CIGAM (32-bit BE)
    b"\xfe\xed\xfa\xcf",  # MH_CIGAM_64 (64-bit BE)
    b"\xca\xfe\xba\xbe",  # FAT_MAGIC
    b"\xca\xfe\xba\xbf",  # FAT_MAGIC_64
})


def java_class_name(raw: bytes) -> str | None:
    """Bounded full JVM structure, not a CAFEBABE/basename exemption.

    Java class and Mach-O FAT share magic. Require a valid constant pool,
    this/super class references, complete fields/methods/attributes and EOF.
    Truncated/forged carriers remain native candidates and fail closed.
    No bytecode is executed; JVM strings still receive the privacy scan.
    """
    if len(raw) < 10 or raw[:4] != b'\xca\xfe\xba\xbe':
        return None
    import struct
    pos = 4
    def take(n):
        nonlocal pos
        if n < 0 or pos + n > len(raw): raise ValueError('truncated class')
        value = raw[pos:pos+n]; pos += n; return value
    def u2(): return struct.unpack('>H', take(2))[0]
    def u4(): return struct.unpack('>I', take(4))[0]
    try:
        minor, major = u2(), u2()
        if not 45 <= major <= 70 or minor not in (0, 3, 65535): return None
        count = u2()
        if count < 2: return None
        cp = [None] * count
        i = 1
        while i < count:
            tag = take(1)[0]
            if tag == 1: cp[i] = ('utf', take(u2()).decode('utf-8', errors='replace'))
            elif tag == 7: cp[i] = ('class', u2())
            elif tag in (8, 16, 19, 20): take(2)
            elif tag in (3, 4, 9, 10, 11, 12, 17, 18): take(4)
            elif tag in (5, 6):
                take(8); i += 1
                if i >= count: return None
            elif tag == 15: take(3)
            else: return None
            i += 1
        def utf(index):
            if not 0 < index < count or not cp[index] or cp[index][0] != 'utf': raise ValueError('bad UTF ref')
            return cp[index][1]
        def klass(index):
            if not 0 < index < count or not cp[index] or cp[index][0] != 'class': raise ValueError('bad class ref')
            name = utf(cp[index][1])
            if not name or '\x00' in name: raise ValueError('bad class name')
            return name
        flags, this, super_class = u2(), u2(), u2()
        name = klass(this)
        if super_class: klass(super_class)
        elif name != 'java/lang/Object' and not flags & 0x8000: return None
        for _ in range(u2()): klass(u2())
        def attributes():
            for _ in range(u2()): utf(u2()); take(u4())
        for _ in range(2):  # fields then methods
            for _ in range(u2()):
                u2(); utf(u2()); utf(u2()); attributes()
        attributes()
        return name if pos == len(raw) else None
    except (ValueError, IndexError, struct.error):
        return None


def is_macho(raw: bytes) -> bool:
    return len(raw) >= 4 and raw[:4] in MACHO_MAGICS and java_class_name(raw) is None


# CPU types from <mach/machine.h> (32-bit values as stored in the header).
_CPUTYPE_X86_64 = 0x01000007
_CPUTYPE_ARM64 = 0x0100000C


def parse_macho_arch(raw: bytes) -> list[str] | None:
    """Parse Mach-O architectures from header bytes (no execution).

    Returns the sorted-unique arch list (e.g. ["arm64"], ["arm64","x86_64"]
    for a fat/universal binary), or None when the bytes are not a
    recognized Mach-O header. Thin headers read `cputype` (bytes 4..8,
    little- or big-endian per magic); FAT headers walk `nfat_arch`
    entries and read each slice's `cputype`. Unknown cputypes are
    reported as `cputype-<hex>` (never silently dropped); truncated
    headers return None (unparseable, never blessed).
    """
    import struct as _struct

    if len(raw) < 4:
        return None
    magic = raw[:4]
    # Little-endian thin (the macOS build output shape).
    if magic in (b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe"):
        if len(raw) < 8:
            return None
        (cputype,) = _struct.unpack_from("<I", raw, 4)
        return [_cputype_name(cputype)]
    # Big-endian thin.
    if magic in (b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf"):
        if len(raw) < 8:
            return None
        (cputype,) = _struct.unpack_from(">I", raw, 4)
        return [_cputype_name(cputype)]
    # FAT / FAT64 (always big-endian headers).
    if magic in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
        if len(raw) < 8:
            return None
        (nfat,) = _struct.unpack_from(">I", raw, 4)
        if nfat == 0 or nfat > 64:
            return None
        arches: list[str] = []
        # fat_arch: cputype(4) cpusubtype(4) offset(4) size(4) align(4);
        # fat_arch_64 adds reserved(4) (total 32 bytes).
        entry_size = 20 if magic == b"\xca\xfe\xba\xbe" else 32
        for i in range(nfat):
            off = 8 + i * entry_size
            if len(raw) < off + 4:
                return None
            (cputype,) = _struct.unpack_from(">I", raw, off)
            arches.append(_cputype_name(cputype))
        return sorted(set(arches))
    return None


def _cputype_name(cputype: int) -> str:
    if cputype == _CPUTYPE_ARM64:
        return "arm64"
    if cputype == _CPUTYPE_X86_64:
        return "x86_64"
    return f"cputype-{cputype:#x}"


def is_allowed_native_bin(name: str) -> bool:
    return name in NATIVE_BIN_ALLOWLIST_SUFFIXES

ZIP_FAMILY = (".zip", ".jar", ".aar", ".apk", ".aab")
TAR_FAMILY = (".tar.gz", ".tgz", ".tar")


def looks_placeholder(value: str) -> bool:
    return any(m in value.lower() for m in PLACEHOLDER_MARKERS)


def _matched_username(matched: str) -> str:
    """Extract the username component from a workstation-path match."""
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


def is_synthetic_path_match(matched: str) -> bool:
    """True only when the match's OWN username is explicitly synthetic.

    Exact (case-insensitive) membership in SYNTHETIC_USERNAMES. Broad
    substrings ("contest" contains "test"), adjacent variable names
    ("example" elsewhere on a minified line), or fixture filenames
    containing "synthetic" never exempt an unrelated real path.
    """
    return _matched_username(matched) in SYNTHETIC_USERNAMES


def match_exempted(text: str, match: re.Match) -> bool:
    """Strict per-match exemption: only the matched path's own explicit
    synthetic username exempts it. Surrounding line context (including
    the old +/-120 char window) is NEVER consulted, so a minified line
    pairing a placeholder variable with a real workstation path (built
    at runtime from fragments in tests) still fails on the real path."""
    return is_synthetic_path_match(match.group(0))


def is_text_member(name: str) -> bool:
    suffix = Path(name).suffix.lower()
    return suffix in TEXT_SUFFIXES


def member_family(name: str) -> str | None:
    lname = name.lower()
    if lname.endswith(ZIP_FAMILY):
        return "zip"
    if lname.endswith((".tar.gz", ".tgz")) or lname.endswith(".tar"):
        return "tar"
    return None


def is_unsafe_name(name: str) -> bool:
    if name.startswith("/") or name.startswith("\\"):
        return True
    parts = Path(name).parts
    if ".." in parts:
        return True
    if re.match(r"(?i)^[a-z]:[\\/]", name):
        return True
    return False


def extract_runs(raw: bytes) -> str:
    """Extract printable strings from binary code/resource bytes.

    ASCII runs plus UTF-16LE runs (AXML/arsc string pools). Runs are
    joined with newlines so a credential pattern can only match when its
    name and value are genuinely adjacent in one run — never stitched
    across unrelated bytes.
    """
    runs: list[str] = []
    for m in ASCII_RUN_RE.finditer(raw):
        try:
            runs.append(m.group(0).decode("ascii"))
        except UnicodeDecodeError:
            continue
    for m in UTF16LE_RUN_RE.finditer(raw):
        try:
            runs.append(m.group(0).decode("utf-16-le"))
        except UnicodeDecodeError:
            continue
    return "\n".join(runs)


class Scanner:
    def __init__(self) -> None:
        self.errors: list[dict] = []
        self.members_out: list[dict] = []
        self.archives_meta: list[dict] = []
        self.total_bytes = 0
        self.file_count = 0
        self.string_scanned = 0
        self.opaque = 0
        self.limited = False

    # -- helpers ------------------------------------------------------
    def fail(self, category: str, path: str, rule: str) -> None:
        self.errors.append({"category": category, "path": path,
                            "rule": rule})

    def check_names(self, name: str, display: str) -> None:
        if SECRET_NAME_RE.search("/" + name):
            self.fail("secret-name", display,
                      "secret-named artifact member")
        if STAGED_CACHE_RE.search("/" + name):
            self.fail("staged-cache", display,
                      "build-cache entry must never ship")

    def scan_text_unit(self, text: str, display: str) -> None:
        for match in ABS_USER_PATH_RE.finditer(text):
            if match_exempted(text, match):
                continue
            self.fail("absolute-path", display,
                      "local absolute workstation path")
            break
        if SOURCEMAP_ABS_RE.search(text):
            self.fail("absolute-sourcemap", display,
                      "absolute sourcemap path")
        for match in TOKEN_ASSIGN_RE.finditer(text):
            try:
                value = match.group(2)
            except IndexError:
                value = ""
            if looks_placeholder(value or ""):
                continue
            self.fail("credential-value", display,
                      "hardcoded credential-looking value")
            break

    def budget(self, nbytes: int, display: str) -> bool:
        self.total_bytes += nbytes
        if self.total_bytes > MAX_TOTAL_BYTES or \
                self.file_count >= MAX_MEMBERS_TOTAL:
            if not self.limited:
                self.fail("limit-exceeded", display,
                          "bundle exceeds inspection bounds "
                          f"(>{MAX_TOTAL_BYTES} expanded bytes or "
                          f">{MAX_MEMBERS_TOTAL} members)")
                self.limited = True
            return False
        return True

    # -- member content ----------------------------------------------
    def scan_blob(self, name: str, raw: bytes, display: str,
                  depth: int) -> list[str] | None:
        """Scan one file's bytes: nested archive, text, string-runs, or
        opaque. `raw` is already bounded by MAX_MEMBER_BYTES. Returns the
        parsed Mach-O arch list for allowlisted native helpers (else None)
        so callers can record provenance without executing anything."""
        family = member_family(name)
        if family is not None:
            if depth >= MAX_DEPTH:
                self.fail("limit-exceeded", display,
                          f"nested archive deeper than {MAX_DEPTH}")
                return None
            self.scan_nested(name, raw, family, display, depth)
            return None
        if len(raw) > MAX_TEXT_BYTES and is_text_member(name):
            # Too large to scan whole: reject, never bless the head.
            self.fail("unscannable-truncated", display,
                      f"text member larger than {MAX_TEXT_BYTES} bytes "
                      "cannot be fully scanned")
            return None
        try:
            text = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            text = ""
            decoded = False
        else:
            decoded = True
        if decoded:
            if text:
                self.scan_text_unit(text, display)
            return None
        if java_class_name(raw) is not None:
            # Kotlin's DebugProbesKt.bin is a JVM class, not a native probe.
            # FULL format validation resolves CAFEBABE collision regardless
            # of filename; all printable carriers receive normal hygiene.
            self.string_scanned += 1
            runs = extract_runs(raw)
            if runs: self.scan_text_unit(runs, display)
            return None
        if is_macho(raw):
            # Native Mach-O: allowlist-only, then privacy strings-scan.
            if not is_allowed_native_bin(name):
                self.fail("unknown-binary", display,
                          "Mach-O member outside the listed native-helper set")
                return None
            arch = parse_macho_arch(raw)
            if arch is None:
                self.fail("unreadable", display,
                          "native-helper Mach-O header unparseable")
                return None
            runs = extract_runs(raw)
            self.string_scanned += 1
            if runs:
                self.scan_text_unit(runs, display)
            return arch
        if STRING_SCAN_NAME_RE.search("/" + name):
            # String window is the whole member: members are already
            # bounded by MAX_MEMBER_BYTES, so carriers like classes.dex
            # (~12 MB) are inspected in full, never on a head sample.
            runs = extract_runs(raw)
            self.string_scanned += 1
            if runs:
                self.scan_text_unit(runs, display)
            return None
        self.opaque += 1  # listed + hashed only (see binary-string policy)
        return None

    # -- containers ----------------------------------------------------
    def scan_nested(self, name: str, raw: bytes, family: str,
                    display: str, depth: int) -> None:
        try:
            if family == "zip":
                self.scan_zip_bytes(raw, display, depth + 1)
            else:
                self.scan_tar_bytes(raw, display, depth + 1)
        except (zipfile.BadZipFile, tarfile.TarError, OSError,
                EOFError) as exc:
            self.fail("unreadable", display,
                      f"nested archive could not be opened: "
                      f"{type(exc).__name__}")

    def scan_zip_bytes(self, raw: bytes, display: str, depth: int) -> None:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            infos = sorted(zf.infolist(), key=lambda i: i.filename)
            meta = {"archive": display, "kind": "zip",
                    "members": len(infos), "string_scanned": 0,
                    "opaque": 0}
            s0, o0 = self.string_scanned, self.opaque
            for info in infos:
                mname = info.filename
                loc = display + "!" + mname
                if mname.endswith("/"):
                    continue
                if is_unsafe_name(mname):
                    self.fail("unsafe-layout", loc,
                              "absolute or parent-escaping member")
                    continue
                self.check_names(mname, loc)
                if info.is_dir():
                    continue
                if info.file_size > MAX_MEMBER_BYTES:
                    self.members_out.append(
                        {"path": loc, "bytes": info.file_size,
                         "sha256": "oversize-unscannable"})
                    self.fail("oversize-unscannable", loc,
                              f"member larger than {MAX_MEMBER_BYTES} "
                              "bytes cannot be scanned")
                    continue
                try:
                    data = zf.read(info.filename)
                except (KeyError, RuntimeError) as exc:
                    self.fail("unreadable", loc,
                              f"member could not be read: "
                              f"{type(exc).__name__}")
                    continue
                if len(data) > MAX_MEMBER_BYTES:
                    self.members_out.append(
                        {"path": loc, "bytes": info.file_size,
                         "sha256": "oversize-unscannable"})
                    self.fail("oversize-unscannable", loc,
                              "member exceeds the scan bound")
                    continue
                self.file_count += 1
                if not self.budget(len(data), loc):
                    self.members_out.append(
                        {"path": loc, "bytes": len(data),
                         "sha256": "limit-exceeded"})
                    continue
                digest = hashlib.sha256(data).hexdigest()
                self.members_out.append({"path": loc, "bytes": len(data),
                                         "sha256": digest})
                _arch = self.scan_blob(mname, data, loc, depth)
                if _arch is not None:
                    self.members_out[-1]["arch"] = "+".join(_arch)
            meta["string_scanned"] = self.string_scanned - s0
            meta["opaque"] = self.opaque - o0
            self.archives_meta.append(meta)

    def verify_native_manifest(self, tf, display):
        """Require exact source/binary/plist hashes and header architectures.

        Manifest strings alone never authorize an arbitrary executable.
        Signature validity is checked on macOS by the acceptance harness;
        this read-only portable scanner verifies the compiled bytes' provenance.
        """
        binary = 'package/resources/bin/watch-asr'
        names = [m.name for m in tf.getmembers()]
        if binary not in names:
            return
        location = (display + '!' if display else '') + binary
        def get(name):
            if names.count(name) != 1:
                raise ValueError('missing/duplicate native provenance member')
            info = tf.getmember(name)
            if not info.isfile() or info.size > MAX_MEMBER_BYTES:
                raise ValueError('unreadable native provenance member')
            return tf.extractfile(info).read(MAX_MEMBER_BYTES + 1)
        try:
            manifest = json.loads(get('package/resources/watch-asr.manifest.json'))
            for key, path in (('binary', 'resources/bin/watch-asr'), ('source', 'resources/watch-asr.swift'), ('plist', 'resources/watch-asr-Info.plist')):
                if manifest.get(key) != path:
                    raise ValueError('native manifest path mismatch')
                data = get('package/' + path)
                if hashlib.sha256(data).hexdigest() != manifest.get(key + 'Sha256'):
                    raise ValueError('native manifest hash mismatch')
            payload = get(binary)
            arches = parse_macho_arch(payload)
            claimed = manifest.get('architectures', [])
            if isinstance(claimed, str):
                claimed = re.split(r'[\s,+]+', claimed.strip())
            if not arches or sorted(claimed) != arches:
                raise ValueError('native manifest architecture mismatch')
            if bool(manifest.get('universal')) != (arches == ['arm64', 'x86_64']):
                raise ValueError('native manifest universal mismatch')
            if manifest.get('minOS') != '13.0':
                raise ValueError('native minimum OS policy mismatch')
        except (ValueError, KeyError, TypeError, OSError, UnicodeDecodeError):
            self.fail('native-provenance', location, 'missing/invalid exact source-binary-plist manifest provenance')

    def scan_tar_bytes(self, raw: bytes, display: str, depth: int) -> None:
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r") as tf:
            self.verify_native_manifest(tf, display)
            infos = sorted(tf.getmembers(), key=lambda m: m.name)
            meta = {"archive": display, "kind": "tar",
                    "members": len(infos), "string_scanned": 0,
                    "opaque": 0}
            s0, o0 = self.string_scanned, self.opaque
            for info in infos:
                mname = info.name
                loc = display + "!" + mname if display else mname
                if is_unsafe_name(mname):
                    self.fail("unsafe-layout", loc,
                              "absolute or parent-escaping member")
                    continue
                if info.issym() or info.islnk():
                    target = info.linkname
                    if target.startswith("/") or \
                            ".." in Path(target).parts or \
                            re.match(r"(?i)^[a-z]:[\\/]", target):
                        self.fail("unsafe-layout", loc,
                                  "symlink target escapes the archive")
                    else:
                        self.members_out.append(
                            {"path": loc, "bytes": 0,
                             "sha256": "symlink-member"})
                    self.check_names(mname, loc)
                    continue
                self.check_names(mname, loc)
                if not info.isfile():
                    self.members_out.append(
                        {"path": loc, "bytes": info.size,
                         "sha256": "non-file-member"})
                    continue
                if info.size > MAX_MEMBER_BYTES:
                    self.members_out.append(
                        {"path": loc, "bytes": info.size,
                         "sha256": "oversize-unscannable"})
                    self.fail("oversize-unscannable", loc,
                              f"member larger than {MAX_MEMBER_BYTES} "
                              "bytes cannot be scanned")
                    continue
                fh = tf.extractfile(info)
                if fh is None:
                    self.fail("unreadable", loc,
                              "member could not be read")
                    continue
                data = fh.read(MAX_MEMBER_BYTES + 1)
                if len(data) > MAX_MEMBER_BYTES:
                    self.members_out.append(
                        {"path": loc, "bytes": info.size,
                         "sha256": "oversize-unscannable"})
                    self.fail("oversize-unscannable", loc,
                              "member exceeds the scan bound")
                    continue
                self.file_count += 1
                if not self.budget(len(data), loc):
                    self.members_out.append(
                        {"path": loc, "bytes": len(data),
                         "sha256": "limit-exceeded"})
                    continue
                digest = hashlib.sha256(data).hexdigest()
                self.members_out.append({"path": loc, "bytes": len(data),
                                         "sha256": digest})
                _arch = self.scan_blob(mname, data, loc, depth)
                if _arch is not None:
                    self.members_out[-1]["arch"] = "+".join(_arch)
            meta["string_scanned"] = self.string_scanned - s0
            meta["opaque"] = self.opaque - o0
            self.archives_meta.append(meta)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--archive", required=True)
    parser.add_argument("--sbom-out", default=None)
    parser.add_argument("--format", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)
    archive = Path(args.archive)

    scanner = Scanner()
    try:
        raw = archive.read_bytes()
    except OSError:
        print("FAIL: cannot open archive: OSError", file=sys.stderr)
        return 1
    if len(raw) > MAX_TOTAL_BYTES:
        scanner.fail("limit-exceeded", archive.name,
                     "outer archive exceeds inspection bounds")
    else:
        scanner.scan_tar_bytes(raw, "", 0)

    members_out = sorted(scanner.members_out, key=lambda m: m["path"])
    errors = scanner.errors

    try:
        archive_sha = hashlib.sha256(raw).hexdigest()
    except OSError:
        archive_sha = "unreadable"

    sbom = {
        "inventory": "wear-dsh-artifacts/1",
        "artifact_archive": archive.name,
        "artifact_sha256": archive_sha,
        "note": "LOCAL review outputs: generic-signed DEBUG/DEV fresh-install APK, "
                "optional owner-signing-required unsigned release, plugin runtime packs. "
                "No production signing keys. Per-member sha256, sorted; no publication authorization.",
        "scan": {
            "nested_archives": len(scanner.archives_meta),
            "string_scanned_members": scanner.string_scanned,
            "opaque_members": scanner.opaque,
            "expanded_bytes": scanner.total_bytes,
            "bounds": {
                "max_depth": MAX_DEPTH,
                "max_members": MAX_MEMBERS_TOTAL,
                "max_member_bytes": MAX_MEMBER_BYTES,
                "max_text_bytes": MAX_TEXT_BYTES,
                "max_total_bytes": MAX_TOTAL_BYTES,
            },
            "archives": sorted(scanner.archives_meta,
                               key=lambda a: a["archive"]),
        },
        "members": members_out,
    }
    text = json.dumps(sbom, indent=2, sort_keys=True) + "\n"
    if args.sbom_out:
        out = Path(args.sbom_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")

    ok = not errors
    if args.format == "json":
        print(json.dumps({"ok": ok, "archive": str(archive),
                          "members": len(members_out),
                          "nested_archives": len(scanner.archives_meta),
                          "errors": errors},
                         indent=2, sort_keys=True))
    else:
        print(f"artifacts: {len(members_out)} member(s) in {archive.name} "
              f"({len(scanner.archives_meta)} nested archive(s), "
              f"{scanner.string_scanned} string-scanned, "
              f"{scanner.opaque} opaque)")
        for meta in sorted(scanner.archives_meta,
                           key=lambda a: a["archive"]):
            print(f"  nested-meta: {meta['archive'] or archive.name} "
                  f"kind={meta['kind']} members={meta['members']} "
                  f"string_scanned={meta['string_scanned']} "
                  f"opaque={meta['opaque']}")
        if ok:
            print("PASS: artifact hygiene ok "
                  "(no absolute paths/sourcemaps/credential values; "
                  "nested archives scanned within bounds)")
        else:
            by_cat: dict[str, int] = {}
            for e in errors:
                by_cat[e["category"]] = by_cat.get(e["category"], 0) + 1
            print(f"FAIL: {len(errors)} problem(s):")
            for cat in sorted(by_cat):
                print(f"  {cat}: {by_cat[cat]}")
                for e in errors:
                    if e["category"] == cat:
                        print(f"    - {e['path']} [{e['rule']}]")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
