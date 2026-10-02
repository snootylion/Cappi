#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Fail-closed stable plugin snapshot before packing; never builds anything."""
import hashlib
from pathlib import Path
import shutil
import sys
import time

SKIP = {'node_modules', '.git', '.DSH', '.dsh', '.gradle', '.kotlin', '__pycache__'}


def inventory(root):
    result = {}
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root)
        if any(part in SKIP for part in rel.parts):
            continue
        if path.is_symlink():
            raise RuntimeError('symlink in plugin snapshot (refusing external linkage)')
        if path.is_file():
            result[str(rel)] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def snapshot(src, dst):
    if not (src / 'lib/index.js').is_file():
        raise RuntimeError('built lib/index.js required; build must finish before snapshot')
    before = inventory(src)
    time.sleep(1)
    if before != inventory(src):
        raise RuntimeError('plugin source/build changed during stable gate; wait for build completion')
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns(*SKIP))
    if before != inventory(src) or before != inventory(dst):
        shutil.rmtree(dst)
        raise RuntimeError('plugin source/build changed while copying; no pack permitted')
    return len(before)


if __name__ == '__main__':
    try:
        count = snapshot(Path(sys.argv[1]), Path(sys.argv[2]))
        print('stable snapshot PASS: %d source/runtime files, full-byte pre/post equality' % count)
    except (OSError, RuntimeError) as error:
        print('REFUSED: ' + str(error), file=sys.stderr)
        raise SystemExit(1)
