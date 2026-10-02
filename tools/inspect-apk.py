#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Verify a fresh-install DEBUG APK with Android's apksigner (never a key)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def standard_debug_subject(value):
    """Accept only Android's generic debug DN, with its optional OU field.

    Android/AGP debug keystores conventionally use CN/O/C. Some hosted
    toolchains also add OU=Android. Accepting that one known variant preserves
    the generic-debug requirement without accepting an owner-specific subject.
    """
    parts = {part.strip() for part in value.split(',') if part.strip()}
    required = {'CN=Android Debug', 'O=Android', 'C=US'}
    return required <= parts and parts <= (required | {'OU=Android'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apk', required=True)
    parser.add_argument('--apksigner', default=os.environ.get('APKSIGNER') or shutil.which('apksigner'))
    parser.add_argument('--out')
    args = parser.parse_args()
    signer = args.apksigner
    if not signer:
        sdk = os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT')
        candidates = sorted(Path(sdk).glob('build-tools/*/apksigner')) if sdk else []
        signer = str(candidates[-1]) if candidates else None
    if not signer:
        print('REFUSED: debug APK needs Android build-tools apksigner; set APKSIGNER (no keystore access)', file=sys.stderr)
        return 1
    env = {k: v for k, v in os.environ.items() if not k.startswith(('DSH_', 'BRIDGE_'))}
    result = subprocess.run([signer, 'verify', '--verbose', '--print-certs', args.apk], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        print('REFUSED: debug APK signature verification failed (no output/identity leaked)', file=sys.stderr)
        return 1
    # Different Android build-tools versions vary insignificant spacing around
    # the otherwise stable `certificate DN:` label. Parse line-by-line rather
    # than treating that presentation detail as a signing-identity change.
    subjects = [
        line.split('certificate DN:', 1)[1].strip()
        for line in result.stdout.splitlines()
        if 'certificate DN:' in line
    ]
    if len(subjects) != 1 or not standard_debug_subject(subjects[0]):
        print('REFUSED: expected one generic Android Debug certificate; owner/private signing identity cannot ship here', file=sys.stderr)
        return 1
    digests = [
        value.lower()
        for line in result.stdout.splitlines()
        if 'certificate SHA-256 digest:' in line
        for value in [line.split('certificate SHA-256 digest:', 1)[1].strip()]
        if re.fullmatch(r'[a-fA-F0-9]{64}', value)
    ]
    if len(digests) != 1:
        print('REFUSED: verified debug certificate SHA256 missing', file=sys.stderr)
        return 1
    apk = Path(args.apk)
    metadata = {'filename': apk.name, 'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'bytes': apk.stat().st_size,
                'signatureVerified': True, 'certificateSubject': 'CN=Android Debug, O=Android, C=US',
                'certificateSha256': digests[0], 'purpose': 'DEBUG/DEV fresh-install test only; NOT production release signed',
                'updatePolicy': 'No original-watch upgrade claim. Future updates require the same signing key; versionCode 3 alone is insufficient.',
                'keystoreBundled': False}
    if args.out:
        Path(args.out).write_text(json.dumps(metadata, indent=2, sort_keys=True) + '\n')
    print('PASS: DEBUG/DEV APK signature verified; generic Android Debug certificate; no keystore bundled')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
