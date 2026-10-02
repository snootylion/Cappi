#!/usr/bin/env python3
"""No-microphone input helper for installed-app smoke tests."""

import json
import sys

for line in sys.stdin:
    command = json.loads(line)
    if command.get("command") == "start":
        print('{"event":"ready"}', flush=True)
    elif command.get("command") == "mute":
        print('{"event":"muted"}' if command.get("muted") else '{"event":"unmuted"}', flush=True)
    elif command.get("command") == "shutdown":
        break
