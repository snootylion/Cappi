"""Tests for tools/scan-secrets.py (stdlib unittest only).
SPDX-License-Identifier: Apache-2.0

All fixture trees AND all realistic-looking bad values are generated at
runtime in temp dirs — no secret ever lives in the repo, including in
this file (bad values are assembled from fragments + randomness so the
scanner's own test corpus stays clean). "Bad" fixtures use
realistic-looking values (long random strings, PEM framing, real-looking
/Users paths, real keystore suffixes); "good" fixtures use explicit
synthetic placeholders (TEST-FIXTURE / EXAMPLE markers, RFC 5737
documentation addresses).
"""

import getpass
import io
import json
import os
import secrets
import subprocess
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS / "lib"))

import importlib.util as _ilu

_spec = _ilu.spec_from_file_location(
    "scan_secrets_mod", TOOLS / "scan-secrets.py")
_scan_mod = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_scan_mod)


def write(root: Path, rel: str, data: bytes) -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def make_token_line() -> tuple[str, str]:
    """Return (source line, secret value) with a realistic random value."""
    value = secrets.token_hex(20)  # 40 hex chars, no placeholder markers
    return f"BRIDGE_TOKEN={value}\n", value


def make_pem_block() -> bytes:
    """Assemble a realistic PEM block from fragments (no literal in repo)."""
    # Fragments never match the private-key rule on their own; only the
    # assembled temp file does.
    begin = "-----BEG" + "IN EC PRIV" + "ATE KEY-----"
    end = "-----END" + " EC PRIVATE " + "KEY-----"
    body = secrets.token_hex(32)
    return f"{begin}\n{body}\n{end}\n".encode()


def make_personal_path_note() -> str:
    user = getpass.getuser()
    assert not _scan_mod.looks_placeholder(user), \
        "test env username looks like a placeholder; pick another env"
    return f"notes at /Users/{user}/Private/keys-notes.txt for later"


# Legitimate synthetic placeholders (accepted): explicit markers only.
GOOD_TOKEN = "BRIDGE_TOKEN=TEST-FIXTURE-PLACEHOLDER-not-a-secret"
GOOD_PATH = "fixture path /Users/example/test-fixture/readme.txt"
GOOD_LINUX_PATH = "fixture path /home/example/test-fixture/readme.txt"
GOOD_WINDOWS_PATH = r"fixture path C:\Users\example\test-fixture\readme.txt"
GOOD_EMAIL = "contact tester@example.com for fixtures"


class ScanTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def categories(self, root=None):
        findings, _ = _scan_mod.scan_root(root or self.root)
        return findings

    def test_rejects_token_filename(self):
        write(self.root, "bridge/token", b"anything")
        cats = {f.category for f in self.categories()}
        self.assertIn("filename:token-file", cats)

    def test_rejects_keystore_and_pem_filenames(self):
        write(self.root, "keys/release.keystore", b"\x00\x01\x02keystore-bytes")
        write(self.root, "keys/bridge-key.pem", b"pem-bytes")
        cats = {f.category for f in self.categories()}
        self.assertIn("filename:signing-material", cats)

    def test_rejects_env_file(self):
        line, _ = make_token_line()
        write(self.root, "bridge/.env", line.encode())
        findings = self.categories()
        cats = {f.category for f in findings}
        self.assertIn("filename:env-secret", cats)

    def test_rejects_hardcoded_token_value(self):
        line, _ = make_token_line()
        write(self.root, "scripts/start.sh",
              b"#!/bin/sh\nexport " + line.encode())
        findings = self.categories()
        self.assertTrue(any(f.category == "content:token-assignment"
                            for f in findings))

    def test_rejects_private_key_block(self):
        write(self.root, "notes/key.txt", make_pem_block())
        findings = self.categories()
        self.assertTrue(any(f.category == "content:private-key-block"
                            for f in findings))

    def test_rejects_real_personal_path(self):
        write(self.root, "docs/note.md", make_personal_path_note().encode())
        findings = self.categories()
        self.assertTrue(any(f.category == "content:personal-path"
                            for f in findings))

    def test_rejects_linux_home_path(self):
        user = getpass.getuser()
        write(self.root, "docs/linux-note.md",
              f"notes at /home/{user}/Private/keys-notes.txt\n".encode())
        findings = self.categories()
        self.assertTrue(any(f.category == "content:linux-home-path"
                            for f in findings))

    def test_rejects_windows_user_path(self):
        user = getpass.getuser()
        # Assembled from fragments so this file's own source never
        # literally matches the windows-user-path rule (same convention
        # as the PEM/token fixtures above).
        bs = chr(92)
        stem = "C:" + bs + "Users" + bs
        write(self.root, "docs/win-note.md",
              f"notes at {stem}{user}{bs}Documents{bs}keys.txt\n".encode())
        fwd = "C:/" + "Users" + "/"
        write(self.root, "docs/win-note-fwd.md",
              f"notes at {fwd}{user}/Documents/keys.txt\n".encode())
        findings = self.categories()
        cats_by_loc = {}
        for f in findings:
            cats_by_loc.setdefault(f.location, []).append(f.category)
        self.assertIn("content:windows-user-path",
                      cats_by_loc.get("docs/win-note.md", []))
        self.assertIn("content:windows-user-path",
                      cats_by_loc.get("docs/win-note-fwd.md", []))

    def test_rejects_personal_email(self):
        local = secrets.token_hex(4)
        write(self.root, "docs/contact.md",
              f"reach {local}@private-mail-domain-{local}.org\n".encode())
        findings = self.categories()
        self.assertTrue(any(f.category == "content:email-address"
                            for f in findings))

    def test_accepts_example_emails(self):
        write(self.root, "docs/contact-ok.md",
              b"reach tester@example.com or someone@mail.test for fixtures\n")
        findings = self.categories()
        self.assertFalse(any(f.category == "content:email-address"
                             for f in findings),
                         "example/test email fixtures must not be flagged")

    def test_rejects_device_identifier(self):
        mac = ":".join(f"{b:02x}" for b in os.urandom(6))
        # Avoid the IANA documentation range so the fixture stays realistic.
        if mac.lower().startswith("00:00:5e"):
            mac = "0a" + mac[2:]
        write(self.root, "docs/net.md",
              f"watch mac {mac} seen on LAN\n".encode())
        write(self.root, "docs/fixture.md",
              b"doc-range example 00:00:5E:EF:10:22 is fine\n")
        findings = self.categories()
        by_loc = {}
        for f in findings:
            by_loc.setdefault(f.location, []).append(f.category)
        self.assertIn("content:device-identifier",
                      by_loc.get("docs/net.md", []))
        self.assertNotIn("docs/fixture.md", by_loc)

    def test_rejects_restored_cappi_assets(self):
        write(self.root,
              "watch-app/app/src/main/assets/cappi/idle_a.gif", b"GIF89a")
        write(self.root,
              "watch-app/app/src/main/assets/cappi/cappi-manifest.json",
              b"{}")
        findings = self.categories()
        paths = {f.location for f in findings
                 if f.category == "untracked-asset"}
        self.assertIn(
            "watch-app/app/src/main/assets/cappi/idle_a.gif", paths)
        self.assertIn(
            "watch-app/app/src/main/assets/cappi/cappi-manifest.json", paths)

    def _write_mock_inventory(self, gif_bytes: bytes = b"GIF89a-mock-frame"):
        import hashlib as _hashlib
        import json as _json
        digest = _hashlib.sha256(gif_bytes).hexdigest()
        provenance = {"license": "Apache-2.0",
                      "files": {"mock_a.gif": {"sha256": digest,
                                              "bytes": len(gif_bytes)}}}
        write(self.root, "characters/cappi-original/provenance.json",
              _json.dumps(provenance).encode())
        return digest

    def test_accepts_hash_verified_licensed_gif(self):
        blob = b"GIF89a-mock-frame"
        self._write_mock_inventory(blob)
        write(self.root, "characters/cappi-original/mock_a.gif", blob)
        write(self.root, "watch-app/app/src/main/assets/characters/"
              "cappi-original/mock_a.gif", blob)
        findings = self.categories()
        bad = [(f.category, f.location) for f in findings
               if "cappi-original" in f.location]
        self.assertEqual([], bad,
                         "manifest-authorized + hash-verified GIFs must pass")

    def test_rejects_uninventoried_licensed_gif(self):
        self._write_mock_inventory()
        write(self.root, "characters/cappi-original/stray.gif", b"GIF89a-x")
        findings = self.categories()
        paths = {f.location for f in findings
                 if f.category == "untracked-asset"}
        self.assertIn("characters/cappi-original/stray.gif", paths)

    def test_rejects_tampered_licensed_gif(self):
        self._write_mock_inventory(b"GIF89a-mock-frame")
        write(self.root, "characters/cappi-original/mock_a.gif",
              b"tampered-bytes")
        findings = self.categories()
        paths = {f.location for f in findings
                 if f.category == "untracked-asset"}
        self.assertIn("characters/cappi-original/mock_a.gif", paths)

    def test_rejects_symlink_escape(self):
        outside_tmp = tempfile.TemporaryDirectory()
        self.addCleanup(outside_tmp.cleanup)
        outside = Path(outside_tmp.name) / "outside.txt"
        outside.write_text("x")
        link = self.root / "bridge" / "evil-link"
        link.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(str(outside), link)
        findings = self.categories()
        self.assertTrue(any(f.category == "symlink-escape" for f in findings))

    def test_rejects_secret_inside_archive(self):
        zpath = write(self.root, "extras/bundle.zip", b"")
        with zipfile.ZipFile(zpath, "w") as zf:
            zf.writestr("config/token", "hardcoded-secret-value-here")
        findings = self.categories()
        locs = [f.location for f in findings]
        self.assertTrue(any("bundle.zip!config/token" in loc for loc in locs),
                        f"archive member not flagged: {locs}")

    def test_archive_mode_scans_built_artifact(self):
        zpath = write(self.root, "dist/candidate.tar.gz", b"")
        import tarfile as _tar
        with _tar.open(zpath, "w:gz") as tf:
            import io as _io
            bad = b"export BRIDGE_TOKEN=" + secrets.token_hex(20).encode()
            ti = _tar.TarInfo("bridge/start.sh")
            ti.size = len(bad)
            tf.addfile(ti, _io.BytesIO(bad))
        proc = subprocess.run(
            [sys.executable, str(TOOLS / "scan-secrets.py"),
             "--archive", str(zpath)],
            capture_output=True, text=True)
        self.assertNotEqual(0, proc.returncode)
        self.assertIn("candidate.tar.gz!bridge/start.sh", proc.stdout)

    def test_accepts_synthetic_placeholders(self):
        write(self.root, "bridge/config.example.sh",
              b"#!/bin/sh\n# copy to config.sh; never commit real values\n"
              + GOOD_TOKEN.encode() + b"\n"
              + b"BASE=http://192.0.2.1:8787  # RFC5737 unpaired marker\n")
        write(self.root, "docs/fixture-note.md", GOOD_PATH.encode())
        write(self.root, "docs/linux-fixture.md", GOOD_LINUX_PATH.encode())
        write(self.root, "docs/win-fixture.md", GOOD_WINDOWS_PATH.encode())
        write(self.root, "docs/email-fixture.md", GOOD_EMAIL.encode())
        write(self.root, "watch-app/app/src/main/assets/cappi/README-GATE.md",
              b"# gate readme\n")
        findings = self.categories()
        self.assertEqual(
            [], [(f.category, f.location) for f in findings],
            "synthetic placeholders must not be flagged")

    def test_gradle_wrapper_jar_allowlisted_but_stray_jar_rejected(self):
        real_jar = (TOOLS.parent / "watch-app/gradle/wrapper/gradle-wrapper.jar")
        self.assertTrue(real_jar.is_file(), "real wrapper jar must exist")
        target = self.root / "watch-app/gradle/wrapper/gradle-wrapper.jar"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(real_jar.read_bytes())
        stray = write(self.root, "extras/tool.jar", b"")
        with zipfile.ZipFile(stray, "w") as zf:
            zf.writestr("Main.class", b"\xca\xfe\xba\xbe" + b"\x00" * 16)
        findings = self.categories()
        by_loc = {}
        for f in findings:
            by_loc.setdefault(f.location, []).append(f.category)
        self.assertNotIn("watch-app/gradle/wrapper/gradle-wrapper.jar", by_loc)
        self.assertIn("unexpected-binary",
                      by_loc.get("extras/tool.jar", []))

    def test_scanner_never_prints_secret_values(self):
        line, secret_value = make_token_line()
        write(self.root, "scripts/start.sh",
              b"export " + line.encode())
        for fmt in ("text", "json"):
            proc = subprocess.run(
                [sys.executable, str(TOOLS / "scan-secrets.py"),
                 "--root", str(self.root), "--format", fmt],
                capture_output=True, text=True)
            self.assertNotEqual(0, proc.returncode)
            combined = proc.stdout + proc.stderr
            self.assertNotIn(secret_value, combined,
                             f"secret leaked in {fmt} output")
            # The offending PATH is reported (actionable), value is not.
            self.assertIn("scripts/start.sh", proc.stdout)

    def test_ignored_gradle_cache_excluded_but_staged_cache_rejected(self):
        # Untracked local cache content is excluded from content scans.
        write(self.root, ".gradle-home/caches/modules-2/x.bin",
              b"\x00\x01binary-cache-bytes")
        findings = self.categories()
        self.assertEqual(
            [], [(f.category, f.location) for f in findings],
            "ignored cache content must be scan-excluded")
        # ... but the same path packed inside an archive is rejected.
        zpath = write(self.root, "extras/sneaky.zip", b"")
        with zipfile.ZipFile(zpath, "w") as zf:
            zf.writestr(".gradle-home/caches/modules-2/x.bin", b"cache")
        findings = self.categories()
        self.assertTrue(
            any(f.category == "staged-cache" for f in findings),
            "cache smuggled inside an archive must be rejected")

    def test_json_report_counts_no_values(self):
        write(self.root, "bridge/token", b"top-secret-bytes")
        proc = subprocess.run(
            [sys.executable, str(TOOLS / "scan-secrets.py"),
             "--root", str(self.root), "--format", "json"],
            capture_output=True, text=True)
        report = json.loads(proc.stdout)
        self.assertFalse(report["ok"])
        self.assertIn("filename:token-file", report["violations_by_category"])
        self.assertNotIn("top-secret-bytes", proc.stdout)


if __name__ == "__main__":
    unittest.main()
