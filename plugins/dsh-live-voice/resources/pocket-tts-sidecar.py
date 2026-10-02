#!/usr/bin/env python3
"""Warm, cancellable JSONL streaming wrapper for CPU-only Kyutai Pocket TTS."""

from __future__ import annotations

import base64
import json
import os
import queue
import sys
import threading
from pathlib import Path
from typing import Any

import numpy as np
from pocket_tts import TTSModel


RUNTIME_ROOT = Path(os.environ.get("DSH_POCKET_TTS_ROOT", "")).expanduser()
DEFAULT_VOICE = os.environ.get("DSH_POCKET_TTS_VOICE", "alba")
write_lock = threading.Lock()
state_lock = threading.Lock()
commands: queue.Queue[dict[str, Any] | None] = queue.Queue()
cancelled: set[str] = set()
shutdown = threading.Event()
model: TTSModel | None = None
voice_states: dict[str, dict[str, Any]] = {}


def emit(payload: dict[str, Any]) -> None:
    with write_lock:
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def ensure_model() -> TTSModel:
    global model
    if model is None:
        model = TTSModel.load_model(language="english")
        emit({"event": "ready", "model": "kyutai/pocket-tts", "voice": DEFAULT_VOICE})
    return model


def ensure_voice(voice: str) -> dict[str, Any]:
    selected = voice or DEFAULT_VOICE
    if selected not in voice_states:
        voice_states[selected] = ensure_model().get_state_for_audio_prompt(selected)
    return voice_states[selected]


def is_cancelled(speech_id: str) -> bool:
    with state_lock:
        return speech_id in cancelled or shutdown.is_set()


def finish_cancel(speech_id: str) -> None:
    with state_lock:
        cancelled.discard(speech_id)


def warm() -> None:
    ensure_voice(DEFAULT_VOICE)
    emit({"event": "warmed"})


def speak(command: dict[str, Any]) -> None:
    speech_id = str(command.get("speechId", ""))
    text = str(command.get("text", "")).strip()
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
        tts = ensure_model()
        for chunk in tts.generate_audio_stream(ensure_voice(voice), text):
            if is_cancelled(speech_id):
                break
            audio = chunk.detach().cpu().numpy().astype(np.float32, copy=False).reshape(-1)
            if audio.size == 0:
                continue
            emit({
                "event": "audio",
                "speechId": speech_id,
                "sequence": sequence,
                "sampleRate": tts.sample_rate,
                "pcmBase64": base64.b64encode(audio.tobytes()).decode("ascii"),
            })
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
        try:
            if action == "warm":
                warm()
            elif action == "speak":
                speak(command)
        except Exception as error:  # noqa: BLE001 - protocol boundary
            emit({"event": "error", "message": str(error)})


def main() -> None:
    if RUNTIME_ROOT:
        RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    emit({"event": "booting", "model": "kyutai/pocket-tts", "voice": DEFAULT_VOICE})
    thread = threading.Thread(target=worker, name="pocket-tts-synthesis", daemon=True)
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


if __name__ == "__main__":
    main()
