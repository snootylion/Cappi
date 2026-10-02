#!/usr/bin/env python3
"""No-audio Kokoro protocol fixture for installed-app smoke tests."""

import json
import base64
import struct
import sys

for line in sys.stdin:
    command = json.loads(line)
    action = command.get("command")
    if action == "warm":
        print('{"event":"ready"}', flush=True)
    elif action == "speak":
        print(json.dumps({
            "event": "audio",
            "speechId": command.get("speechId"),
            "sequence": 0,
            "sampleRate": 4,
            "pcmBase64": base64.b64encode(struct.pack("<4f", 0.0, 0.0, 0.0, 0.0)).decode("ascii"),
        }), flush=True)
        print(json.dumps({"event": "done", "speechId": command.get("speechId"), "cancelled": False}), flush=True)
    elif action == "shutdown":
        break
