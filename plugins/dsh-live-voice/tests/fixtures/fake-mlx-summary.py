#!/usr/bin/env python3
import json
import os
import sys
import threading
import time

start_log = os.environ.get("DSH_KOKORO_TEST_START_LOG")
if start_log:
    with open(start_log, "a", encoding="utf-8") as handle:
        handle.write(f"{os.getpid()}\n")

cancelled: set[str] = set()
write_lock = threading.Lock()


def emit(message: dict) -> None:
    with write_lock:
        print(json.dumps(message, separators=(",", ":")), flush=True)


def summarize(command: dict) -> None:
    request_id = str(command["requestId"])
    if "slow cancellation fixture" in command["prompt"]:
        for _ in range(100):
            if request_id in cancelled:
                emit({"event": "done", "requestId": request_id, "cancelled": True})
                return
            time.sleep(0.005)
    emit({"event": "delta", "requestId": request_id, "text": "Local concise result."})
    emit({"event": "done", "requestId": request_id, "cancelled": False})


emit({"event": "booting"})
for line in sys.stdin:
    command = json.loads(line)
    action = command.get("command")
    if action == "warm":
        emit({"event": "ready", "model": os.environ.get("DSH_KOKORO_SUMMARY_MODEL"), "pid": os.getpid()})
    elif action == "summarize":
        threading.Thread(target=summarize, args=(command,), daemon=True).start()
    elif action == "cancel":
        cancelled.add(str(command["requestId"]))
    elif action == "shutdown":
        break
