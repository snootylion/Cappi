#!/usr/bin/env python3
"""Warm, cancellable JSONL streaming wrapper for local Kokoro-82M speech."""

from __future__ import annotations

import base64
import contextlib
import json
import os
import queue
import sys
import threading
from pathlib import Path
from typing import Any

import numpy as np
from kokoro_mlx import KokoroTTS


DEFAULT_MODEL = "mlx-community/Kokoro-82M-bf16"
MODEL_PATH = os.environ.get("PI_GUI_VOICE_MODEL", DEFAULT_MODEL)
DEFAULT_VOICE = "af_heart"
SAMPLE_RATE = 24_000

write_lock = threading.Lock()
state_lock = threading.Lock()
commands: queue.Queue[dict[str, Any] | None] = queue.Queue()
cancelled: set[str] = set()
shutdown = threading.Event()
model: KokoroTTS | None = None
synthesis_warmed = False


def emit(payload: dict[str, Any]) -> None:
    with write_lock:
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def ensure_model() -> KokoroTTS:
    global model
    if model is None:
        source = Path(MODEL_PATH) if Path(MODEL_PATH).is_dir() else MODEL_PATH
        with contextlib.redirect_stdout(sys.stderr):
            model = KokoroTTS.from_pretrained(source)
        emit({"event": "ready", "model": MODEL_PATH, "voice": DEFAULT_VOICE})
    return model


def warm_synthesis() -> None:
    global synthesis_warmed
    if synthesis_warmed:
        return
    # Compile the first MLX synthesis graph without sending hidden audio. The
    # ready event is emitted by ensure_model() first, so Live Voice startup is
    # not blocked while this continues on the serialized worker.
    for _chunk in ensure_model().generate_stream(
        text="Let me check that carefully.",
        voice=DEFAULT_VOICE,
        speed=1.0,
        sample_rate=SAMPLE_RATE,
    ):
        pass
    synthesis_warmed = True
    emit({"event": "warmed"})


def is_cancelled(speech_id: str) -> bool:
    with state_lock:
        return speech_id in cancelled or shutdown.is_set()


def finish_cancel(speech_id: str) -> None:
    with state_lock:
        cancelled.discard(speech_id)


def speak(command: dict[str, Any]) -> None:
    speech_id = str(command.get("speechId", ""))
    text = str(command.get("text", "")).strip()
    rate = min(1.2, max(0.8, float(command.get("rate", 1.0))))
    voice = str(command.get("voice", DEFAULT_VOICE))
    if not speech_id or not text:
        emit({"event": "error", "speechId": speech_id, "message": "Speech text is empty."})
        return
    if is_cancelled(speech_id):
        emit({"event": "done", "speechId": speech_id, "cancelled": True})
        finish_cancel(speech_id)
        return

    try:
        sequence = 0
        for chunk in ensure_model().generate_stream(
            text=text,
            voice=voice,
            speed=rate,
            sample_rate=SAMPLE_RATE,
        ):
            if is_cancelled(speech_id):
                break
            audio = np.asarray(chunk, dtype=np.float32).reshape(-1)
            if audio.size == 0:
                continue
            emit(
                {
                    "event": "audio",
                    "speechId": speech_id,
                    "sequence": sequence,
                    "sampleRate": SAMPLE_RATE,
                    "pcmBase64": base64.b64encode(audio.tobytes()).decode("ascii"),
                }
            )
            sequence += 1
        emit({"event": "done", "speechId": speech_id, "cancelled": is_cancelled(speech_id)})
    except Exception as error:  # noqa: BLE001 - protocol boundary must report model errors
        emit({"event": "error", "speechId": speech_id, "message": str(error)})
    finally:
        finish_cancel(speech_id)


def worker() -> None:
    while not shutdown.is_set():
        command = commands.get()
        if command is None:
            break
        action = command.get("command")
        if action == "warm":
            try:
                ensure_model()
                warm_synthesis()
            except Exception as error:  # noqa: BLE001 - protocol boundary
                emit({"event": "error", "message": str(error)})
        elif action == "speak":
            speak(command)


def main() -> None:
    emit({"event": "booting", "model": MODEL_PATH, "voice": DEFAULT_VOICE})
    thread = threading.Thread(target=worker, name="kokoro-synthesis", daemon=True)
    thread.start()
    try:
        for line in sys.stdin:
            try:
                command = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(command, dict):
                continue
            action = command.get("command")
            if action in {"warm", "speak"}:
                commands.put(command)
            elif action == "cancel":
                speech_id = str(command.get("speechId", ""))
                if speech_id:
                    with state_lock:
                        cancelled.add(speech_id)
            elif action == "shutdown":
                break
    finally:
        shutdown.set()
        commands.put(None)
        thread.join(timeout=10)
        if model is not None and not thread.is_alive():
            model.close()


if __name__ == "__main__":
    main()
