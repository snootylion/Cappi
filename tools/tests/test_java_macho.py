# SPDX-License-Identifier: Apache-2.0
"""CAFEBABE format collision must not weaken native or privacy gates."""
import importlib.util
import io
from pathlib import Path
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('jvm_artifacts', TOOLS / 'inspect-artifacts.py')
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)


def java_class(extra=None):
    def utf(value):
        data = value.encode('utf-8')
        return b'\x01' + struct.pack('>H', len(data)) + data
    name = 'kotlin/coroutines/jvm/internal/DebugProbesKt'
    pool = utf(name) + b'\x07\x00\x01' + utf('java/lang/Object') + b'\x07\x00\x03'
    if extra is not None: pool += utf(extra)
    return (b'\xca\xfe\xba\xbe' + struct.pack('>HHH', 0, 52, 5 + (extra is not None)) + pool
            + struct.pack('>HHHHHHH', 0x31, 2, 4, 0, 0, 0, 0))


def fat_macho():
    return b'\xca\xfe\xba\xbe' + struct.pack('>I', 2) + b''.join(
        struct.pack('>IIIII', cpu, 0, 48 + i*8, 8, 2)
        for i, cpu in enumerate((0x0100000C, 0x01000007))) + b'\x00'*16


class JavaMachOFormatTest(unittest.TestCase):
    def test_real_jvm_structure_is_not_native(self):
        payload = java_class()
        self.assertEqual('kotlin/coroutines/jvm/internal/DebugProbesKt', mod.java_class_name(payload))
        self.assertFalse(mod.is_macho(payload))

    def test_same_magic_fat_native_still_requires_manifest_policy(self):
        payload = fat_macho()
        self.assertIsNone(mod.java_class_name(payload))
        self.assertTrue(mod.is_macho(payload))
        self.assertEqual(['arm64', 'x86_64'], mod.parse_macho_arch(payload))
        self.assertFalse(mod.is_allowed_native_bin('DebugProbesKt.bin'))

    def test_magic_truncation_bad_class_reference_and_appended_payload_refused(self):
        good = java_class()
        for payload in (good[:10], good[:-1], good + fat_macho(),
                        good[:-10] + b'\xff\xff' + good[-8:]):
            with self.subTest(length=len(payload)):
                self.assertIsNone(mod.java_class_name(payload))
                self.assertTrue(mod.is_macho(payload))

    def inspect(self, payload):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'input.tgz'
            with tarfile.open(path, 'w:gz') as tf:
                info = tarfile.TarInfo('DebugProbesKt.bin'); info.size = len(payload)
                tf.addfile(info, io.BytesIO(payload))
            return subprocess.run([sys.executable, str(TOOLS/'inspect-artifacts.py'), '--archive', str(path)], capture_output=True, text=True)

    def test_structural_class_allowed_but_native_under_same_filename_refused(self):
        self.assertEqual(0, self.inspect(java_class()).returncode)
        result = self.inspect(fat_macho())
        self.assertNotEqual(0, result.returncode)
        self.assertIn('unknown-binary', result.stdout)

    def test_valid_jvm_class_strings_still_receive_private_path_hygiene(self):
        private = '/' + 'Users' + '/runnerperson/Documents/never-print-this'
        result = self.inspect(java_class(private))
        self.assertNotEqual(0, result.returncode)
        self.assertIn('absolute-path', result.stdout)
        self.assertNotIn(private, result.stdout + result.stderr)


if __name__ == '__main__': unittest.main()
