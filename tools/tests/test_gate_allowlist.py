"""Tests for check-license-gate.py, ALLOWLIST.txt and export-source.sh.
SPDX-License-Identifier: Apache-2.0
"""

import hashlib as _hashlib
import importlib.util as _ilu
import json as _json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
ROOT = TOOLS.parent

_spec = _ilu.spec_from_file_location(
    "gate_mod", TOOLS / "check-license-gate.py")
_gate = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_gate)

_spec2 = _ilu.spec_from_file_location(
    "common_mod", TOOLS / "lib" / "release_common.py")
_common = _ilu.module_from_spec(_spec2)
_spec2.loader.exec_module(_common)


def write(root: Path, rel: str, data: bytes = b"x") -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def write_mock_licensed_pack(root: Path, n: int = 25) -> dict:
    """Synthesize a mock licensed cappi-original inventory in a temp root.

    Returns the {gif_name: sha256} inventory. Uses deterministic fake GIF
    bytes (no real assets); the count defaults to the 25-file contract so
    the mock exercises the same path the real pack takes.
    """
    names = [f"mock_{i:02d}.gif" for i in range(n)]
    files = {}
    for i, name in enumerate(names):
        blob = f"GIF89a-mock-frame-{i}".encode()
        files[name] = {"sha256": _hashlib.sha256(blob).hexdigest(),
                       "bytes": len(blob)}
        write(root, f"characters/cappi-original/{name}", blob)
        write(root, f"watch-app/app/src/main/assets/characters/"
                    f"cappi-original/{name}", blob)
    pack = {"license": "Apache-2.0",
            "clips": {name: {"width": 98, "height": 98, "duration_s": 1.0}
                      for name in names}}
    pack_bytes = _json.dumps(pack, sort_keys=True).encode()
    write(root, "characters/cappi-original/pack.json", pack_bytes)
    write(root, "watch-app/app/src/main/assets/characters/"
          "cappi-original/pack.json", pack_bytes)
    provenance = {"license": "Apache-2.0", "files": files}
    prov_bytes = _json.dumps(provenance, sort_keys=True).encode()
    write(root, "characters/cappi-original/provenance.json", prov_bytes)
    write(root, "watch-app/app/src/main/assets/characters/"
          "cappi-original/provenance.json", prov_bytes)
    write(root, "characters/registry.json", _json.dumps(
        {"characters": [{"id": "cappi-original"}]}).encode())
    return {name: files[name]["sha256"] for name in names}


def write_grants(root: Path) -> Path:
    return write(root, "LICENSE-DECISION.md",
                 b"# decision\n"
                 b"UPSTREAM-VOICE-GRANT: Apache-2.0 owner-approved 2026-09-27\n"
                 b"CONFIRMED-BY-USER: Apache-2.0 owner-approved 2026-09-27\n"
                 b"CAPPI-ORIGINAL-GRANT: Apache-2.0 owner-approved 2026-09-27\n")


class GateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_empty_tree_blocks_license_gates(self):
        gates = {g["id"]: g for g in _gate.check_gates(self.root)}
        self.assertEqual(3, len(gates))
        # Empty tree: no grants recorded and no licensed inventory, so
        # every gate blocks (legacy dir clean but inventory pending).
        self.assertTrue(gates["cappi-binaries"]["blocked"])
        self.assertTrue(gates["upstream-voice"]["blocked"])
        self.assertTrue(gates["project-license"]["blocked"])

    def test_cappi_binary_blocks_that_gate(self):
        write(self.root,
              "watch-app/app/src/main/assets/cappi/README-GATE.md", b"# gate")
        write(self.root,
              "watch-app/app/src/main/assets/cappi/idle_a.gif", b"GIF89a")
        write_grants(self.root)
        write_mock_licensed_pack(self.root)
        gates = {g["id"]: g for g in _gate.check_gates(self.root)}
        self.assertTrue(gates["cappi-binaries"]["blocked"])
        self.assertIn("idle_a.gif", gates["cappi-binaries"]["detail"])

    def test_gate_readme_alone_leaves_inventory_gate_open(self):
        # A clean legacy dir is necessary but not sufficient: without the
        # recorded grant + verifying hash inventory the gate stays open.
        write(self.root,
              "watch-app/app/src/main/assets/cappi/README-GATE.md", b"# gate")
        gates = {g["id"]: g for g in _gate.check_gates(self.root)}
        self.assertTrue(gates["cappi-binaries"]["blocked"])

    def test_explicit_markers_close_gates(self):
        write(self.root,
              "watch-app/app/src/main/assets/cappi/README-GATE.md", b"# gate")
        write_grants(self.root)
        write_mock_licensed_pack(self.root)
        gates = _gate.check_gates(self.root)
        self.assertFalse(any(g["blocked"] for g in gates))

    def test_missing_inventory_blocks_despite_grants(self):
        write(self.root,
              "watch-app/app/src/main/assets/cappi/README-GATE.md", b"# gate")
        write_grants(self.root)
        gates = {g["id"]: g for g in _gate.check_gates(self.root)}
        self.assertTrue(gates["cappi-binaries"]["blocked"])
        self.assertFalse(gates["upstream-voice"]["blocked"])
        self.assertFalse(gates["project-license"]["blocked"])

    def test_tampered_inventory_blocks_gate(self):
        write(self.root,
              "watch-app/app/src/main/assets/cappi/README-GATE.md", b"# gate")
        write_grants(self.root)
        write_mock_licensed_pack(self.root)
        write(self.root,
              "characters/cappi-original/mock_00.gif", b"tampered-bytes")
        gates = {g["id"]: g for g in _gate.check_gates(self.root)}
        self.assertTrue(gates["cappi-binaries"]["blocked"])

    def test_uninventoried_gif_blocks_gate(self):
        write(self.root,
              "watch-app/app/src/main/assets/cappi/README-GATE.md", b"# gate")
        write_grants(self.root)
        write_mock_licensed_pack(self.root)
        write(self.root,
              "characters/cappi-original/stray.gif", b"GIF89a-stray")
        write(self.root,
              "watch-app/app/src/main/assets/characters/"
              "cappi-original/stray.gif", b"GIF89a-stray")
        gates = {g["id"]: g for g in _gate.check_gates(self.root)}
        self.assertTrue(gates["cappi-binaries"]["blocked"])

    def test_approved_tree_reports_closed_gates(self):
        # The approved truth: owner-recorded Apache-2.0 grants plus the
        # verifying licensed-pack hash inventory close every gate. The
        # toolchain must report that — and must still block anything
        # less (see the mock tests above).
        gates = {g["id"]: g for g in _gate.check_gates(ROOT)}
        self.assertFalse(gates["cappi-binaries"]["blocked"],
                         "licensed Cappi inventory must verify: "
                         + gates["cappi-binaries"]["detail"])
        self.assertFalse(gates["upstream-voice"]["blocked"])
        self.assertFalse(gates["project-license"]["blocked"])


class AllowlistTest(unittest.TestCase):
    def setUp(self):
        self.dirs, self.files, self.excepts = _common.load_allowlist()

    def test_required_paths_allowlisted(self):
        for rel in (
            "watch-app/gradle/wrapper/gradle-wrapper.jar",
            "watch-app/app/src/main/assets/cappi/README-GATE.md",
            "characters/dot-default/pack.json",
            "characters/cappi-original/pack.json",
            "characters/cappi-original/provenance.json",
            "watch-app/app/src/main/assets/characters/"
            "cappi-original/pack.json",
            "watch-app/app/src/main/assets/characters/"
            "cappi-original/provenance.json",
            "characters/registry.json",
            "LICENSE",
            "NOTICE.md",
            "LICENSE-DECISION.md",
            "plugins/dsh-watch/LICENSE",
            "plugins/dsh-watch/NOTICE.md",
            "plugins/dsh-live-voice/LICENSE",
            "plugins/dsh-live-voice/NOTICE.md",
            "protocol/transport-endpoints.md",
            "tools/scan-secrets.py",
            "tools/lib/release_common.py",
            "tools/tests/test_scan.py",
        ):
            self.assertTrue(
                _common.is_allowlisted(rel, self.dirs, self.files, self.excepts),
                f"{rel} must be allowlisted")

    def test_licensed_cappi_gifs_allowlisted_via_dir_rules(self):
        # The 25 licensed GIFs (+ mirrors) stage via the characters/ and
        # watch-app/ dir rules; the hash backstop (not the allowlist) is
        # what restricts them to the manifest-authorized set. Read the
        # real inventory so the test tracks the pack without hardcoding
        # contributor-owned filenames.
        import json as _json
        provenance = _json.loads(
            (ROOT / "characters/cappi-original/provenance.json")
            .read_text(encoding="utf-8"))
        names = [n for n in provenance.get("files", {})
                 if n.lower().endswith(".gif")]
        self.assertEqual(25, len(names))
        for name in names:
            for rel in (f"characters/cappi-original/{name}",
                        f"watch-app/app/src/main/assets/characters/"
                        f"cappi-original/{name}"):
                self.assertTrue(
                    _common.is_allowlisted(rel, self.dirs, self.files,
                                           self.excepts),
                    f"{rel} must be allowlisted (hash backstop restricts)")

    def test_private_paths_not_allowlisted(self):
        for rel in (
            "watch-app/app/src/main/assets/cappi/idle_a.gif",
            "watch-app/app/src/main/assets/cappi/cappi-manifest.json",
            ".release-work/local-assets/cappi/idle_a.gif",
            "plugins/dsh-live-voice/node_modules/foo/index.js",
            "watch-app/app/build/outputs/apk/debug/app-debug.apk",
        ):
            self.assertFalse(
                _common.is_allowlisted(rel, self.dirs, self.files, self.excepts),
                f"{rel} must NOT be allowlisted")

    def test_secret_names_refused_even_when_allowlisted(self):
        # dir: rules necessarily cover some names (e.g. bridge/token);
        # the shared forbidden-name rule is the export backstop.
        for rel in (
            "bridge/token",
            "bridge/bridge-key.pem",
            "keys/release.keystore",
            "watch-app/release-signing.properties",
            "service.log",
            "REPORT-FINALPACK.md",
            "docs/REPORT-X.md",
        ):
            self.assertTrue(_common.is_forbidden_name(rel),
                            f"{rel} must be export-refused")
        self.assertFalse(_common.is_forbidden_name(
            "watch-app/release-signing.properties.example"))
        self.assertFalse(_common.is_forbidden_name(
            "bridge/setup-cert.sh"))

    def test_allowlist_files_exist_in_tree(self):
        missing = [f for f in self.files
                   if not (ROOT / f).is_file() and not (ROOT / f).is_dir()
                   and not (ROOT / f).exists()]
        # scripts/executables listed must exist; report any stale entries.
        self.assertEqual([], missing, f"stale allowlist entries: {missing}")

    def test_export_list_matches_allowlist(self):
        proc = subprocess.run(
            ["sh", str(TOOLS / "export-source.sh"), "--list"],
            capture_output=True, text=True, cwd=str(ROOT))
        self.assertEqual(0, proc.returncode, proc.stderr)
        listed = proc.stdout.split()
        self.assertIn(
            "watch-app/gradle/wrapper/gradle-wrapper.jar", listed)
        self.assertNotIn(
            "watch-app/app/src/main/assets/cappi/cappi-manifest.json", listed)
        self.assertFalse(any(p.startswith("plugins/dsh-live-voice/lib/")
                             for p in listed),
                         "build outputs must not export")
        self.assertFalse(any("node_modules" in p for p in listed),
                         "vendored deps must not export")
        # Plugin package + installer completeness: lockfiles, configs,
        # patch files, and resource installers needed for a fresh build.
        for rel in (
            "plugins/dsh-watch/package.json",
            "plugins/dsh-watch/pnpm-lock.yaml",
            "plugins/dsh-watch/cordis.patch.yml",
            "plugins/dsh-watch/src/index.ts",
            "plugins/dsh-watch/src/config.ts",
            "plugins/dsh-watch/src/client/index.tsx",
            "plugins/dsh-watch/src/client/settings.ts",
            "plugins/dsh-watch/src/host-adapter.ts",
            "plugins/dsh-watch/src/watch-api.ts",
            "plugins/dsh-watch/SKILL.md",
            "plugins/dsh-live-voice/package.json",
            "plugins/dsh-live-voice/pnpm-lock.yaml",
            "plugins/dsh-live-voice/cordis.patch.yml",
            "plugins/dsh-live-voice/src/index.ts",
            "plugins/dsh-live-voice/src/watch-api.ts",
            "plugins/dsh-live-voice/src/watch-service.ts",
            "plugins/dsh-live-voice/src/client/index.tsx",
            "plugins/dsh-live-voice/scripts/build-watch-helpers.sh",
            "plugins/dsh-live-voice/resources/watch-asr.swift",
            "plugins/dsh-live-voice/resources/watch-asr-Info.plist",
            "plugins/dsh-live-voice/resources/watch-asr.manifest.json",
            "plugins/dsh-live-voice/resources/bin/.gitignore",
            "plugins/dsh-live-voice/resources/kokoro-tts-requirements.txt",
        ):
            self.assertIn(rel, listed, f"{rel} must export")
        # Compiled native helpers never ship in the SOURCE archive
        # (built at pack time into the npm tar via `resources`; source
        # carries the Swift source + build script + manifest only).
        self.assertNotIn(
            "plugins/dsh-live-voice/resources/bin/watch-asr", listed,
            "compiled native helper must NOT pollute the source archive")
        # CI + companion skill ship in the clean archive (regression: a
        # prior allowlist omitted both, so clean checkouts could not run
        # the published pipeline or the watch skill from source).
        self.assertIn(".github/workflows/ci.yml", listed,
                      "CI workflow must export")
        # Deterministic: two runs resolve identically.
        proc2 = subprocess.run(
            ["sh", str(TOOLS / "export-source.sh"), "--list"],
            capture_output=True, text=True, cwd=str(ROOT))
        self.assertEqual(proc.stdout, proc2.stdout)


class PluginManifestTest(unittest.TestCase):
    """Exact `exports`/`files` expectations for the shippable plugins.

    The --artifacts bundle packs these manifests with `npm pack`, so the
    manifests pin exactly what an installable plugin contains: built
    lib/ outputs, the DSH patch file, docs/skill companions, and (voice)
    the local resources dir. Any drift here changes installable contents
    and must be a deliberate, reviewed edit — not silent rot.
    """

    WATCH_EXPECTED_EXPORTS = {
        ".": {"types": "./lib/index.d.ts", "default": "./lib/index.js"},
        "./client": "./lib/client.js",
        "./cordis.patch.yml": "./cordis.patch.yml",
        "./package.json": "./package.json",
    }
    WATCH_EXPECTED_FILES = [
        "lib", "cordis.patch.yml", "README.md", "SKILL.md", "PROVENANCE.md",
        "LICENSE", "NOTICE.md",
    ]
    VOICE_EXPECTED_EXPORTS = {
        ".": {"types": "./lib/index.d.ts", "default": "./lib/index.js"},
        "./client": "./lib/client.js",
        "./watch-api": {
            "types": "./lib/watch-api.d.ts",
            "default": "./lib/watch-api.js",
        },
        "./cordis.patch.yml": "./cordis.patch.yml",
        "./package.json": "./package.json",
    }
    VOICE_EXPECTED_FILES = [
        "lib", "resources", "resources/watch-asr.swift",
        "resources/watch-asr-Info.plist",
        "resources/watch-asr.manifest.json",
        "resources/bin/watch-asr",
        "scripts/build-watch-helpers.sh",
        "cordis.patch.yml", "README.md",
        "LICENSE", "NOTICE.md",
    ]

    def load_manifest(self, plugin):
        import json
        path = ROOT / "plugins" / plugin / "package.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_watch_exports_and_files_exact(self):
        manifest = self.load_manifest("dsh-watch")
        self.assertEqual(self.WATCH_EXPECTED_EXPORTS, manifest["exports"])
        self.assertEqual(self.WATCH_EXPECTED_FILES, manifest["files"])
        self.assertEqual("lib/index.js", manifest["main"])
        self.assertEqual("lib/index.d.ts", manifest["types"])
        self.assertEqual("Apache-2.0", manifest["license"])
        self.assertNotIn("private", manifest)

    def test_voice_exports_and_files_exact(self):
        manifest = self.load_manifest("dsh-live-voice")
        self.assertEqual(self.VOICE_EXPECTED_EXPORTS, manifest["exports"])
        self.assertEqual(self.VOICE_EXPECTED_FILES, manifest["files"])
        self.assertEqual("lib/index.js", manifest["main"])
        self.assertEqual("lib/index.d.ts", manifest["types"])
        self.assertEqual("Apache-2.0", manifest["license"])
        self.assertNotIn("private", manifest)

    def test_manifest_pack_inputs_exist_in_tree(self):
        """Every manifest `files` entry that is SOURCE (not a build
        output) must resolve to a real path, or `npm pack` would
        silently ship a thinner plugin than the manifest promises.
        `lib/` is a build output: it is intentionally absent from the
        source archive (source-only policy) and its presence at pack
        time is enforced by release-bundle.sh, not here — so this test
        must also pass on a clean-source extract."""
        import json
        for plugin in ("dsh-watch", "dsh-live-voice"):
            manifest = self.load_manifest(plugin)
            base = ROOT / "plugins" / plugin
            for entry in manifest["files"]:
                if entry == "lib":
                    continue  # build output; source-only archive excludes it
                if entry == "resources/bin/watch-asr":
                    continue  # built native helper; gitignored, built at
                    # pack time (or compiled on target); its presence at
                    # pack time is enforced by the vanilla-install harness
                    # (phase 9 manifest truth), not by the source archive
                self.assertTrue((base / entry).exists(),
                                f"{plugin}: pack entry missing: {entry}")

    def test_pack_file_lists_stay_source_complete(self):
        """Source export must still carry everything `npm pack` needs:
        manifests plus the SKILL companion (watch) and resources (voice),
        plus each plugin's LICENSE/NOTICE companions. The root LICENSE
        and the licensed-Cappi manifests must export too; the 25 licensed
        GIFs (+ mirrors) export via dir rules under the hash backstop.
        Built lib/ stays OUT of the source archive (source-only)."""
        proc = subprocess.run(
            ["sh", str(TOOLS / "export-source.sh"), "--list"],
            capture_output=True, text=True, cwd=str(ROOT))
        self.assertEqual(0, proc.returncode, proc.stderr)
        listed = proc.stdout.split()
        for rel in (
            "LICENSE",
            "plugins/dsh-watch/package.json",
            "plugins/dsh-watch/SKILL.md",
            "plugins/dsh-watch/cordis.patch.yml",
            "plugins/dsh-watch/src/client/index.tsx",
            "plugins/dsh-watch/src/host-adapter.ts",
            "plugins/dsh-watch/LICENSE",
            "plugins/dsh-watch/NOTICE.md",
            "plugins/dsh-live-voice/package.json",
            "plugins/dsh-live-voice/cordis.patch.yml",
            "plugins/dsh-live-voice/src/watch-api.ts",
            "plugins/dsh-live-voice/src/watch-service.ts",
            "plugins/dsh-live-voice/scripts/build-watch-helpers.sh",
            "plugins/dsh-live-voice/resources/watch-asr.swift",
            "plugins/dsh-live-voice/resources/watch-asr-Info.plist",
            "plugins/dsh-live-voice/resources/watch-asr.manifest.json",
            "plugins/dsh-live-voice/resources/bin/.gitignore",
            "plugins/dsh-live-voice/LICENSE",
            "plugins/dsh-live-voice/NOTICE.md",
            "plugins/dsh-live-voice/resources/kokoro-tts-requirements.txt",
            "characters/cappi-original/pack.json",
            "characters/cappi-original/provenance.json",
            "watch-app/app/src/main/assets/characters/"
            "cappi-original/pack.json",
            ".github/workflows/ci.yml",
        ):
            self.assertIn(rel, listed, f"{rel} must export")
        cappi_gifs = [p for p in listed
                      if p.startswith("characters/cappi-original/")
                      and p.lower().endswith(".gif")]
        mirror_gifs = [p for p in listed
                       if p.startswith("watch-app/app/src/main/assets/"
                                       "characters/cappi-original/")
                       and p.lower().endswith(".gif")]
        self.assertEqual(25, len(cappi_gifs),
                         "all 25 licensed GIFs must export")
        self.assertEqual(25, len(mirror_gifs),
                         "all 25 licensed GIF mirrors must export")
        self.assertFalse(any("/lib/" in p for p in listed
                             if p.startswith("plugins/")),
                         "built lib/ must not pollute the source archive")
        self.assertNotIn(
            "plugins/dsh-live-voice/resources/bin/watch-asr", listed,
            "compiled native helper must NOT pollute the source archive")


class ExportConfinementTest(unittest.TestCase):
    def run_export(self, *args):
        return subprocess.run(
            ["sh", str(TOOLS / "export-source.sh"), *args],
            capture_output=True, text=True, cwd=str(ROOT))

    def test_outside_dist_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = self.run_export("--dry-run", "--out",
                                   str(Path(tmp) / "evil.tar.gz"))
            self.assertNotEqual(0, proc.returncode)
            self.assertIn("dist/", proc.stderr)

    def test_absolute_tmp_out_refused(self):
        proc = self.run_export("--dry-run", "--out", "/tmp/evil.tar.gz")
        self.assertNotEqual(0, proc.returncode)

    def test_parent_escape_refused(self):
        proc = self.run_export("--dry-run", "--out",
                               "dist/../evil.tar.gz")
        self.assertNotEqual(0, proc.returncode)

    def test_newline_out_refused(self):
        proc = self.run_export("--dry-run", "--out",
                               "dist/e\nvil.tar.gz")
        self.assertNotEqual(0, proc.returncode)

    def test_dist_relative_out_accepted(self):
        proc = self.run_export("--dry-run",
                               "--out", "dist/.test-dryrun.tar.gz")
        self.assertEqual(0, proc.returncode, proc.stderr)


class PortabilityTest(unittest.TestCase):
    """Static Linux-compat checks: fail here, not only on Ubuntu CI."""

    def test_gnu_tar_flag_spelling(self):
        text = (TOOLS / "export-source.sh").read_text(encoding="utf-8")
        self.assertIn("--sort=name", text)
        self.assertNotIn("--sort-name", text)
        self.assertIn("GZIP=-n", text)

    def test_mktemp_templates_gnu_compatible(self):
        for script in ("export-source.sh", "verify.sh",
                       "installer-dryrun.sh", "release-bundle.sh"):
            text = (TOOLS / script).read_text(encoding="utf-8") \
                if (TOOLS / script).is_file() else ""
            if "mktemp" not in text:
                continue
            self.assertNotRegex(
                text, r"mktemp\s+-t\s+\S+\s*\n",
                f"{script}: bare `mktemp -t prefix` breaks GNU mktemp")
            self.assertIn("XXXXXX", text,
                          f"{script}: mktemp template must carry XXXXXX")


class ReproducibilityTest(unittest.TestCase):
    def test_two_archives_bit_identical(self):
        import hashlib
        import tarfile
        # dist-confined outputs (export refuses paths outside dist/).
        outs = [ROOT / "dist" / f".test-src-{i}.tar.gz" for i in ("a", "b")]
        try:
            for out in outs:
                proc = subprocess.run(
                    ["sh", str(TOOLS / "export-source.sh"),
                     "--out", f"dist/{out.name}"],
                    capture_output=True, text=True, cwd=str(ROOT),
                    env={**dict(__import__("os").environ),
                         "SOURCE_DATE_EPOCH": "1700000000"})
                self.assertEqual(0, proc.returncode, proc.stderr)
            digests = []
            for out in outs:
                digest = hashlib.sha256()
                with open(out, "rb") as fh:
                    digest.update(fh.read())
                digests.append(digest.hexdigest())
            self.assertEqual(digests[0], digests[1],
                             "exports must be bit-reproducible")
            with tarfile.open(outs[0], "r") as tf:
                names = tf.getnames()
            self.assertIn(
                "watch-app/gradle/wrapper/gradle-wrapper.jar", names)
            self.assertFalse(any(n.endswith("/token") or n.endswith(".pem")
                                 for n in names),
                             "no secret-named members in archive")
            self.assertFalse(any("node_modules" in n for n in names),
                             "no vendored deps in archive")
        finally:
            for out in outs:
                try:
                    out.unlink()
                except OSError:
                    pass
                try:
                    Path(str(out) + ".sha256").unlink()
                except OSError:
                    pass

    def test_fresh_extraction_proves_allowlist(self):
        """Extract a fresh archive in a temp dir: every allowlist file
        entry must be present, and the tree scan passes on the extract."""
        import importlib.util as _ilu
        import tarfile
        _spec = _ilu.spec_from_file_location(
            "scan_mod_fresh", TOOLS / "scan-secrets.py")
        _scan = _ilu.module_from_spec(_spec)
        _spec.loader.exec_module(_scan)
        out = ROOT / "dist" / ".test-fresh-extract.tar.gz"
        try:
            proc = subprocess.run(
                ["sh", str(TOOLS / "export-source.sh"),
                 "--out", f"dist/{out.name}"],
                capture_output=True, text=True, cwd=str(ROOT),
                env={**dict(__import__("os").environ),
                     "SOURCE_DATE_EPOCH": "1700000000"})
            self.assertEqual(0, proc.returncode, proc.stderr)
            with tempfile.TemporaryDirectory() as tmp:
                with tarfile.open(out, "r") as tf:
                    tf.extractall(tmp)
                # Spot-check: installers, plugin modules, fixtures, docs.
                for rel in (
                    "plugins/dsh-live-voice/resources/kokoro-tts-requirements.txt",
                    "plugins/dsh-watch/src/index.ts",
                    "plugins/dsh-watch/cordis.patch.yml",
                    "protocol/fixtures/health.json",
                    "tools/scan-secrets.py",
                    "docs/ONBOARDING.md",
                ):
                    self.assertTrue(
                        Path(tmp, rel).is_file(),
                        f"fresh extract missing {rel}")
                findings, _ = _scan.scan_root(Path(tmp))
                self.assertEqual(
                    [], [(f.category, f.location) for f in findings],
                    "fresh extract must scan clean")
        finally:
            try:
                out.unlink()
            except OSError:
                pass
            try:
                Path(str(out) + ".sha256").unlink()
            except OSError:
                pass


class InspectArtifactsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def make_tar(self, name, members):
        import io as _io
        import tarfile as _tar
        path = self.root / name
        with _tar.open(path, "w:gz") as tf:
            for rel, data in members.items():
                raw = data if isinstance(data, bytes) else data.encode()
                ti = _tar.TarInfo(rel)
                ti.size = len(raw)
                tf.addfile(ti, _io.BytesIO(raw))
        return path

    def run_inspect(self, archive, extra=()):
        import importlib.util as _ilu
        spec = _ilu.spec_from_file_location(
            "inspect_artifacts_mod", TOOLS / "inspect-artifacts.py")
        mod = _ilu.module_from_spec(spec)
        spec.loader.exec_module(mod)
        sbom = self.root / "artifacts-sbom.json"
        rc = mod.main(["--archive", str(archive),
                       "--sbom-out", str(sbom), *extra])
        return rc, mod, sbom

    def test_clean_members_pass_with_sbom(self):
        tar = self.make_tar("clean.tar.gz", {
            "plugins/dsh-watch/lib/index.js":
                "// built output, relative sourcemap\n"
                "//# sourceMappingURL=index.js.map\n",
            "plugins/dsh-watch/lib/index.js.map":
                '{"version":3,"sources":["../src/index.ts"]}',
        })
        rc, _, sbom = self.run_inspect(tar)
        self.assertEqual(0, rc)
        self.assertTrue(sbom.is_file())

    def test_absolute_sourcemap_refused(self):
        # Fragments: this file's own source must never literally match
        # the absolute-path rules (it ships inside the source archive).
        mac = "/" + "Users" + "/" + "builder" + "/" + "work"
        tar = self.make_tar("bad.tar.gz", {
            "plugins/dsh-watch/lib/index.js":
                f"//# sourceMappingURL={mac}/index.js.map\n",
        })
        rc, _, _ = self.run_inspect(tar)
        self.assertNotEqual(0, rc)

    def test_local_absolute_path_refused(self):
        lin = "/" + "home" + "/" + "builder" + "/" + "work"
        tar = self.make_tar("bad2.tar.gz", {
            "plugins/dsh-watch/lib/index.js":
                f"// built on {lin} machine\n",
        })
        rc, _, _ = self.run_inspect(tar)
        self.assertNotEqual(0, rc)

    def test_release_bundle_help_is_honest(self):
        proc = subprocess.run(
            ["sh", str(TOOLS / "release-bundle.sh"), "--help"],
            capture_output=True, text=True, cwd=str(ROOT))
        self.assertEqual(0, proc.returncode)
        combined = proc.stdout + proc.stderr
        self.assertIn("sidecar", combined.lower())
        self.assertIn("--artifacts", combined)

    def test_placeholder_elsewhere_does_not_mask_real_path(self):
        """Match-local exemption regression: a valid placeholder on one
        line must NOT mask an unrelated private path on another line.
        The private value must never appear in the output."""
        import getpass
        import secrets as _secrets
        user = getpass.getuser()
        victim = "/" + "Users" + "/" + user + "/" + "Private" + "/notes.txt"
        blob = ("fixture /Users/example/test-fixture/readme.txt\n"
                f"notes at {victim} for later\n"
                f"export BRIDGE_TOKEN={_secrets.token_hex(20)}\n")
        tar = self.make_tar("mask.tar.gz", {
            "plugins/dsh-watch/lib/index.js": blob,
        })
        proc = subprocess.run(
            [sys.executable, str(TOOLS / "inspect-artifacts.py"),
             "--archive", str(tar)],
            capture_output=True, text=True)
        self.assertNotEqual(0, proc.returncode)
        combined = proc.stdout + proc.stderr
        self.assertNotIn(user, combined,
                         "private username leaked into inspector output")
        self.assertNotIn("Private", combined)
        self.assertIn("absolute-path", combined)
        self.assertIn("credential-value", combined)

    def test_nested_apk_secret_and_path_refused_without_values(self):
        """An embedded credential + a private path inside a nested APK
        (zip) fail the bundle; neither value is printed."""
        import getpass
        import secrets as _secrets
        import zipfile as _zip
        user = getpass.getuser()
        token = _secrets.token_hex(20)
        victim = "/" + "Users" + "/" + user + "/" + "Private" + "/k.txt"
        import io as _io
        buf = _io.BytesIO()
        with _zip.ZipFile(buf, "w") as zf:
            zf.writestr("assets/config.txt",
                        f"export BRIDGE_TOKEN={token}\n")
            # Synthetic DEX: header magic + an ASCII run with a path.
            zf.writestr("classes.dex",
                        b"dex\n035\x00" + b"\x00" * 16
                        + f"notes at {victim} here".encode())
        apk_path = self.root / "nested.apk"
        apk_path.write_bytes(buf.getvalue())
        import tarfile as _tar
        outer = self.root / "outer.tar.gz"
        with _tar.open(outer, "w:gz") as tf:
            ti = _tar.TarInfo("apk/app-release-unsigned.apk")
            ti.size = apk_path.stat().st_size
            with open(apk_path, "rb") as fh:
                tf.addfile(ti, fh)
        proc = subprocess.run(
            [sys.executable, str(TOOLS / "inspect-artifacts.py"),
             "--archive", str(outer)],
            capture_output=True, text=True)
        self.assertNotEqual(0, proc.returncode, proc.stdout)
        combined = proc.stdout + proc.stderr
        self.assertNotIn(token, combined, "credential leaked into output")
        self.assertNotIn(user, combined, "username leaked into output")
        self.assertIn("credential-value", combined)
        self.assertIn("absolute-path", combined)
        self.assertIn("nested-meta", combined)

    def test_nested_plugin_tgz_path_refused(self):
        """A private path inside a nested plugin .tgz (tar) fails."""
        import getpass
        import io as _io
        import tarfile as _tar
        user = getpass.getuser()
        victim = "/" + "home" + "/" + user + "/" + "work" + "/k.txt"
        inner = _io.BytesIO()
        with _tar.open(fileobj=inner, mode="w:gz") as tf:
            raw = (f"// built on {victim} machine\n").encode()
            ti = _tar.TarInfo("package/lib/index.js")
            ti.size = len(raw)
            tf.addfile(ti, _io.BytesIO(raw))
            pkg = b'{"name":"dsh-watch","version":"0.2.0-rc0"}'
            ti2 = _tar.TarInfo("package/package.json")
            ti2.size = len(pkg)
            tf.addfile(ti2, _io.BytesIO(pkg))
        tar = self.make_tar("outer2.tar.gz", {
            "plugins/dsh-watch-0.2.0-rc0.tgz": inner.getvalue(),
        })
        rc, _, _ = self.run_inspect(tar)
        self.assertNotEqual(0, rc)

    def test_symlink_escape_refused(self):
        """A tar symlink pointing outside the archive fails."""
        import io as _io
        import tarfile as _tar
        outer = self.root / "link.tar.gz"
        with _tar.open(outer, "w:gz") as tf:
            ti = _tar.TarInfo("plugins/evil-link")
            ti.type = _tar.SYMTYPE
            ti.linkname = "/" + "etc" + "/" + "passwd"
            tf.addfile(ti)
            raw = b"// clean\n"
            ti2 = _tar.TarInfo("plugins/dsh-watch/lib/index.js")
            ti2.size = len(raw)
            tf.addfile(ti2, _io.BytesIO(raw))
        rc, _, _ = self.run_inspect(outer)
        self.assertNotEqual(0, rc)

    def test_oversize_text_rejected_not_blessed(self):
        """A text member beyond the scan window fails instead of passing
        on its head bytes."""
        import importlib.util as _ilu
        spec = _ilu.spec_from_file_location(
            "inspect_artifacts_mod2", TOOLS / "inspect-artifacts.py")
        mod = _ilu.module_from_spec(spec)
        spec.loader.exec_module(mod)
        big = "x = 1; // clean head\n".encode() + b"y" * (mod.MAX_TEXT_BYTES + 8)
        tar = self.make_tar("big.tar.gz", {
            "plugins/dsh-watch/lib/index.js": big,
        })
        rc, _, _ = self.run_inspect(tar)
        self.assertNotEqual(0, rc)

    def test_same_line_placeholder_does_not_mask_real_path_minified_js(self):
        """Minified single line: placeholder beside a real path still FAILS.

        Guards the old +/-120 char same-line window exemption: a minified
        line pairing a placeholder variable with a real workstation path
        must reject on the real path without echoing values. The generic
        "user" username is NOT synthetic and must also fail, while the
        "example" username stays exempt.
        """
        import getpass
        import importlib.util as _ilu
        spec = _ilu.spec_from_file_location(
            "inspect_artifacts_mod3", TOOLS / "inspect-artifacts.py")
        mod = _ilu.module_from_spec(spec)
        spec.loader.exec_module(mod)
        # Strict allowlist checks (assembled from fragments so this file's
        # own source never literally matches the absolute-path rules).
        uex = "/" + "Users" + "/" + "example" + "/x"
        utfix = "/" + "Users" + "/" + "TEST-FIXTURE" + "/x"
        ugen = "/" + "Users" + "/" + "user" + "/x"
        ubld = "/" + "Users" + "/" + "builder" + "/x"
        self.assertTrue(mod.is_synthetic_path_match(uex))
        self.assertTrue(mod.is_synthetic_path_match(utfix))
        self.assertFalse(mod.is_synthetic_path_match(ugen))
        self.assertFalse(mod.is_synthetic_path_match(ubld))
        user = getpass.getuser()
        self.assertNotIn(user.lower(), mod.SYNTHETIC_USERNAMES,
                          "test env username is synthetic; pick another env")
        u = "/" + "Users" + "/" + user + "/" + "Private" + "/k.txt"
        gen = "/" + "Users" + "/" + "user" + "/" + "docs" + "/k.txt"
        # Single minified line: synthetic placeholder + generic user path
        # + the runtime real path, plus a model-fixture filename carrying
        # the word "synthetic" that must NOT exempt anything.
        line = ("const example='placeholder';"
                "const a='/Users/example/app.js';"
                f"const b='{gen}';"
                f"const c='{u}';"
                "// synthetic-model-fixture minified")
        tar = self.make_tar("minified.tar.gz", {
            "plugins/dsh-watch/lib/index.js": line,
        })
        proc = subprocess.run(
            [sys.executable, str(TOOLS / "inspect-artifacts.py"),
             "--archive", str(tar)],
            capture_output=True, text=True)
        self.assertNotEqual(0, proc.returncode, proc.stdout)
        combined = proc.stdout + proc.stderr
        self.assertNotIn(user, combined, "username leaked into output")
        self.assertNotIn("Private", combined)
        self.assertIn("absolute-path", combined)

    def test_apk_string_run_placeholder_does_not_mask_real_path(self):
        """Nested APK string-run: synthetic prose beside a real path FAILS.

        The DEX ASCII run mixes placeholder/synthetic prose with a real
        workstation path in one contiguous run; the old window exemption
        would bless it, the strict per-match rule must reject it without
        echoing values.
        """
        import getpass
        import io as _io
        import zipfile as _zip
        user = getpass.getuser()
        victim = "/" + "Users" + "/" + user + "/" + "Private" + "/k.txt"
        buf = _io.BytesIO()
        with _zip.ZipFile(buf, "w") as zf:
            payload = (b"dex\n035\x00" + b"\x00" * 16
                       + b"example placeholder synthetic TEST-FIXTURE "
                       + b"/Users/example/a.js notes at "
                       + victim.encode() + b" end-of-run")
            zf.writestr("classes.dex", payload)
        apk_path = self.root / "mask-run.apk"
        apk_path.write_bytes(buf.getvalue())
        import tarfile as _tar
        outer = self.root / "outer-run.tar.gz"
        with _tar.open(outer, "w:gz") as tf:
            ti = _tar.TarInfo("apk/app-release-unsigned.apk")
            ti.size = apk_path.stat().st_size
            with open(apk_path, "rb") as fh:
                tf.addfile(ti, fh)
        proc = subprocess.run(
            [sys.executable, str(TOOLS / "inspect-artifacts.py"),
             "--archive", str(outer)],
            capture_output=True, text=True)
        self.assertNotEqual(0, proc.returncode, proc.stdout)
        combined = proc.stdout + proc.stderr
        self.assertNotIn(user, combined, "username leaked into output")
        self.assertNotIn("Private", combined)
        self.assertIn("absolute-path", combined)


class NativeArchTest(unittest.TestCase):
    """Mach-O arch parsing: header bytes (never basenames/manifest strings).

    The vanilla-install harness (phase 9) compares these parsed arches
    against the helper manifest (`architectures` + `universal`); the
    scanner records the same parse per allowlisted member (`arch`).
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        import importlib.util as _ilu
        spec = _ilu.spec_from_file_location(
            "inspect_arch_mod", TOOLS / "inspect-artifacts.py")
        self.mod = _ilu.module_from_spec(spec)
        spec.loader.exec_module(self.mod)

    def tearDown(self):
        self.tmp.cleanup()

    def thin(self, cputype, le=True):
        import struct as _st
        magic = b"\xcf\xfa\xed\xfe" if le else b"\xfe\xed\xfa\xcf"
        fmt = "<I" if le else ">I"
        return magic + _st.pack(fmt, cputype) + b"\x00" * 64

    def fat(self, cputypes):
        import struct as _st
        raw = b"\xca\xfe\xba\xbe" + _st.pack(">I", len(cputypes))
        for ct in cputypes:
            raw += _st.pack(">IIIII", ct, 0, 0, 0, 0)
        return raw + b"\x00" * 64

    def wrap_plugin_tgz(self, members):
        if 'package/resources/bin/watch-asr' in members and 'package/resources/watch-asr.manifest.json' not in members:
            payload = members['package/resources/bin/watch-asr']
            source, plist = b'// synthetic helper source', b'<plist>synthetic</plist>'
            members['package/resources/watch-asr.swift'] = source
            members['package/resources/watch-asr-Info.plist'] = plist
            members['package/resources/watch-asr.manifest.json'] = _json.dumps({
                'source': 'resources/watch-asr.swift', 'sourceSha256': _hashlib.sha256(source).hexdigest(),
                'plist': 'resources/watch-asr-Info.plist', 'plistSha256': _hashlib.sha256(plist).hexdigest(),
                'binary': 'resources/bin/watch-asr', 'binarySha256': _hashlib.sha256(payload).hexdigest(),
                'architectures': self.mod.parse_macho_arch(payload),
                'universal': len(self.mod.parse_macho_arch(payload) or []) > 1, 'minOS': '13.0',
            }).encode()
        import io as _io
        import tarfile as _tar
        inner = _io.BytesIO()
        with _tar.open(fileobj=inner, mode="w:gz") as tf:
            for rel, data in members.items():
                ti = _tar.TarInfo(rel)
                ti.size = len(data)
                tf.addfile(ti, _io.BytesIO(data))
        outer = self.root / "bundle.tar.gz"
        with _tar.open(outer, "w:gz") as tf:
            ti = _tar.TarInfo("plugins/dsh-live-voice-0.3.0-rc0.tgz")
            ti.size = len(inner.getvalue())
            tf.addfile(ti, _io.BytesIO(inner.getvalue()))
        return outer

    def inspect(self, archive):
        import importlib.util as _ilu
        spec = _ilu.spec_from_file_location(
            "inspect_arch_mod2", TOOLS / "inspect-artifacts.py")
        mod = _ilu.module_from_spec(spec)
        spec.loader.exec_module(mod)
        sbom = self.root / "arch-sbom.json"
        rc = mod.main(["--archive", str(archive),
                       "--sbom-out", str(sbom)])
        import json as _json
        return rc, _json.loads(sbom.read_text(encoding="utf-8"))

    def test_parse_thin_arm64(self):
        self.assertEqual(
            ["arm64"], self.mod.parse_macho_arch(self.thin(0x0100000C)))

    def test_parse_thin_x86_64(self):
        self.assertEqual(
            ["x86_64"], self.mod.parse_macho_arch(self.thin(0x01000007)))

    def test_parse_fat_universal(self):
        self.assertEqual(["arm64", "x86_64"],
                         self.mod.parse_macho_arch(
                             self.fat([0x01000007, 0x0100000C])))

    def test_parse_non_macho_is_none(self):
        self.assertIsNone(self.mod.parse_macho_arch(b"#!/bin/sh\n"))
        self.assertIsNone(self.mod.parse_macho_arch(b"\xcf\xfa"))

    def test_thin_arm64_helper_passes_with_recorded_arch(self):
        tar = self.wrap_plugin_tgz({
            "package/resources/bin/watch-asr": self.thin(0x0100000C),
            "package/package.json": b'{"name":"dsh-live-voice-kokoro"}',
        })
        rc, sbom = self.inspect(tar)
        self.assertEqual(0, rc)
        members = [m for m in sbom["members"]
                   if m["path"].endswith("resources/bin/watch-asr")]
        self.assertEqual(1, len(members))
        self.assertEqual("arm64", members[0].get("arch"))
        self.assertTrue(members[0]["path"].endswith(
            "package/resources/bin/watch-asr"))

    def test_fat_helper_records_both_arches(self):
        tar = self.wrap_plugin_tgz({
            "package/resources/bin/watch-asr":
                self.fat([0x01000007, 0x0100000C]),
            "package/package.json": b'{"name":"dsh-live-voice-kokoro"}',
        })
        rc, sbom = self.inspect(tar)
        self.assertEqual(0, rc)
        members = [m for m in sbom["members"]
                   if m["path"].endswith("resources/bin/watch-asr")]
        self.assertEqual("arm64+x86_64", members[0].get("arch"))

    def test_legacy_bin_path_refused_without_exact_resource_manifest(self):
        tar = self.wrap_plugin_tgz({
            "package/bin/watch-asr": self.thin(0x0100000C),
            "package/package.json": b'{"name":"dsh-live-voice-kokoro"}',
        })
        rc, sbom = self.inspect(tar)
        self.assertNotEqual(0, rc)

    def test_native_manifest_wrong_hash_refused(self):
        tar = self.wrap_plugin_tgz({
            'package/resources/bin/watch-asr': self.thin(0x0100000C),
            'package/resources/watch-asr.manifest.json': b'{}',
        })
        rc, _ = self.inspect(tar)
        self.assertNotEqual(0, rc)

    def test_native_path_suffix_collision_refused(self):
        tar = self.wrap_plugin_tgz({'untrusted/package/resources/bin/watch-asr': self.thin(0x0100000C)})
        rc, _ = self.inspect(tar)
        self.assertNotEqual(0, rc)

    def test_macho_outside_allowlist_still_refused(self):
        tar = self.wrap_plugin_tgz({
            "package/bin/evil-helper": self.thin(0x0100000C),
            "package/package.json": b'{"name":"dsh-live-voice-kokoro"}',
        })
        rc, _ = self.inspect(tar)
        self.assertNotEqual(0, rc)

    def test_truncated_macho_header_refused(self):
        tar = self.wrap_plugin_tgz({
            "package/bin/watch-asr": b"\xcf\xfa\xed\xfe",
            "package/package.json": b'{"name":"dsh-live-voice-kokoro"}',
        })
        rc, _ = self.inspect(tar)
        self.assertNotEqual(0, rc)


class VanillaHarnessTest(unittest.TestCase):
    """Static guards for tools/test-vanilla-install.sh (EA-owned).

    The live --full run needs ephemeral boots; these tests pin the
    harness CONTRACT instead: official entry/CLI only, no production
    ports, no bare launcher, fixture ROUTING leg shape, conservative
    native verdicts. No secrets or local paths live in this file.
    """

    def setUp(self):
        self.text = (TOOLS / "test-vanilla-install.sh").read_text(
            encoding="utf-8")

    def fixture_js(self):
        marker = 'cat > "$FIXTURE_DIR/lib/index.js" <<\'EOF\'\n'
        i = self.text.index(marker) + len(marker)
        j = self.text.index("\nEOF\n", i)
        return self.text[i:j]

    def test_official_entry_and_cli_only(self):
        self.assertIn("resolve_js_entry", self.text)
        self.assertIn("plugin --profile web add", self.text)
        self.assertIn("NEVER /opt/homebrew/bin/dsh", self.text)
        self.assertNotRegex(self.text, r"(?m)^\s*dsh ",
                            "bare `dsh` must never run (official JS entry only)")

    def test_forbidden_ports_fail_closed(self):
        self.assertIn('FORBIDDEN_PORTS="3083 8787 8789"', self.text)
        self.assertIn("check_no_forbidden_port", self.text)

    def test_fixture_uses_official_adapter_and_exact_dto(self):
        js = self.fixture_js()
        self.assertIn("ctx.llm.registerAdapter", js)
        self.assertIn("content: [{ type: 'text', text: PHRASE }]".replace(
            "PHRASE", "PHRASE"), js)
        self.assertNotIn("{ sessionId, text }", js)
        self.assertNotIn("{ sessionId, input }", js)
        self.assertNotIn("reasoning", js)
        for token in ("FIXTURE turnkey routing check alpha",
                      "fixture-local", "fixture-echo-1"):
            self.assertIn(token, js)
        # Fixture is temp-only: no live paths, no secrets, no network.
        self.assertNotIn("/Users/", js)
        self.assertNotIn("BRIDGE_TOKEN", js)
        self.assertNotIn("fetch(", js)

    def test_fixture_js_parses_under_node(self):
        import shutil as _shutil
        if _shutil.which("node") is None:
            self.skipTest("node unavailable for fixture syntax check")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "fixture-check.mjs"
            path.write_text(self.fixture_js(), encoding="utf-8")
            proc = subprocess.run(
                ["node", "--check", str(path)],
                capture_output=True, text=True)
            self.assertEqual(0, proc.returncode, proc.stderr)

    def test_routing_verdict_never_claims_native(self):
        self.assertIn("ROUTING_PASS", self.text)
        self.assertIn("--require-native", self.text)
        self.assertIn("REQUIRE_NATIVE", self.text)
        # Fake-ASR routing is labelled; native-pending exits 3 by
        # default and fails closed only under the explicit flag.
        self.assertIn("never a native claim", self.text)

    def test_node22_leg_isolated_and_optional(self):
        self.assertIn("node@22", self.text)
        self.assertIn("npm-cache", self.text)
        self.assertIn("--skip-node22", self.text)

    def test_negative_legs_present(self):
        for needle in ("cappi-wrong", "revoke", "wrong-session cappi",
                       "no reconnect", "meaningful"):
            self.assertIn(needle, self.text,
                          f"negative leg missing: {needle}")

    def test_secrets_are_runtime_generated_not_hardcoded(self):
        # Enrollment/token secrets come from a runtime CSPRNG into 600
        # files; the only literal session string is the mismatch fixture.
        self.assertIn("secrets.token_urlsafe", self.text)
        self.assertIn("mismatch-session-TEST-FIXTURE", self.text)

    def test_native_gate_from_packed_status_not_sine(self):
        # Native leg must gate on the PACKED helper --status diagnostic
        # (authorized + locale/on-device), drive explicit voice setup +
        # generated-speech PCM, and require ackFinals>=1. Sine-wave
        # uploads never prove recognition and must stay out.
        for needle in ("--status", "admin/voice/setup",
                       '{"consent":true}', "turnkey voice check",
                       "ackFinals", "NATIVE_PASS", "NATIVE_GATE",
                       "REPORT-EN"):
            self.assertIn(needle, self.text,
                          f"native gate marker missing: {needle}")
        self.assertNotIn("math.sin", self.text,
                         "sine-wave PCM fixture must not ship as an ASR leg")
        # The old unconditional PENDING line is gone: the gate reports the
        # exact authorized/blocked state instead.
        self.assertNotIn("PENDING os-speech-recognition: platform STT needs",
                         self.text)
        # Production TTS frames come from the real synth over live SSE.
        for needle in ("speech-started", "audio-done", "pcmBase64"):
            self.assertIn(needle, self.text,
                          f"native TTS wire marker missing: {needle}")


if __name__ == "__main__":
    unittest.main()
