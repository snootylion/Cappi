#!/usr/bin/env python3
"""Warm, cancellable JSONL adapter for the private MLX voice summarizer."""

from __future__ import annotations

import contextlib
import json
import os
import queue
import sys
import threading
import time
from typing import Any

from mlx_lm import load, stream_generate
from mlx_lm.sample_utils import make_sampler


MODEL_PATH = os.environ.get("DSH_KOKORO_SUMMARY_MODEL", "").strip()
commands: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=8)
cancelled: set[str] = set()
cancel_lock = threading.Lock()
write_lock = threading.Lock()
shutdown = threading.Event()
model: Any = None
tokenizer: Any = None
generation_warmed = False


def emit(payload: dict[str, Any]) -> None:
    with write_lock:
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def is_cancelled(request_id: str) -> bool:
    with cancel_lock:
        return request_id in cancelled or shutdown.is_set()


def clear_cancel(request_id: str) -> None:
    with cancel_lock:
        cancelled.discard(request_id)


def ensure_model() -> tuple[Any, Any]:
    global model, tokenizer
    if model is None or tokenizer is None:
        if not MODEL_PATH:
            raise RuntimeError("DSH_KOKORO_SUMMARY_MODEL is not configured.")
        started = time.monotonic()
        # MLX/Hugging Face libraries may print progress. Keep stdout strictly
        # JSONL because the Node host treats every line as protocol data.
        with contextlib.redirect_stdout(sys.stderr):
            model, tokenizer = load(MODEL_PATH)
        emit({"event": "ready", "model": MODEL_PATH, "loadMs": round((time.monotonic() - started) * 1000)})
    return model, tokenizer


def generate_stream(rendered: str, max_tokens: int, temperature: float):
    active_model, active_tokenizer = ensure_model()
    responses = stream_generate(
        active_model,
        active_tokenizer,
        prompt=rendered,
        max_tokens=max_tokens,
        sampler=make_sampler(temp=temperature, top_p=0.95),
    )

    while True:
        # Some MLX generators print memory warnings to stdout. Advance the
        # library iterator under a narrow redirect, then restore stdout before
        # protocol events are emitted by the caller.
        with contextlib.redirect_stdout(sys.stderr):
            try:
                response = next(responses)
            except StopIteration:
                return
        yield response


def render_prompt(system: str, prompt: str) -> str:
    _, active_tokenizer = ensure_model()
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": prompt},
    ]
    options = {"tokenize": False, "add_generation_prompt": True, "enable_thinking": False}
    try:
        return active_tokenizer.apply_chat_template(messages, **options)
    except TypeError:
        options.pop("enable_thinking")
        return active_tokenizer.apply_chat_template(messages, **options)


def warm_generation() -> None:
    global generation_warmed
    if generation_warmed:
        return
    ensure_model()
    rendered = render_prompt(
        "Return only a brief neutral phrase with thinking disabled.",
        "Say: Let me check that carefully.",
    )
    for _response in generate_stream(rendered, max_tokens=1, temperature=0.0):
        pass
    generation_warmed = True
    emit({"event": "warmed"})


def summarize(command: dict[str, Any]) -> None:
    request_id = str(command.get("requestId", ""))
    system = str(command.get("system", "")).strip()
    prompt = str(command.get("prompt", "")).strip()
    max_tokens = min(192, max(1, int(command.get("maxTokens", 160))))
    if not request_id or not system or not prompt:
        emit({"event": "error", "requestId": request_id, "message": "Summary request is incomplete."})
        return
    if is_cancelled(request_id):
        emit({"event": "done", "requestId": request_id, "cancelled": True})
        clear_cancel(request_id)
        return
    try:
        ensure_model()
        rendered = render_prompt(system, prompt)
        started = time.monotonic()
        first_token_ms: int | None = None
        token_count = 0
        for response in generate_stream(rendered, max_tokens=max_tokens, temperature=0.2):
            if is_cancelled(request_id):
                break
            text = response.text
            if not text:
                continue
            if first_token_ms is None:
                first_token_ms = round((time.monotonic() - started) * 1000)
            token_count += 1
            emit({"event": "delta", "requestId": request_id, "text": text})
        was_cancelled = is_cancelled(request_id)
        emit({
            "event": "done",
            "requestId": request_id,
            "cancelled": was_cancelled,
            "firstTokenMs": first_token_ms,
            "elapsedMs": round((time.monotonic() - started) * 1000),
            "tokens": token_count,
        })
    except Exception as error:  # noqa: BLE001 - protocol boundary
        emit({"event": "error", "requestId": request_id, "message": str(error)})
    finally:
        clear_cancel(request_id)


def worker() -> None:
    while not shutdown.is_set():
        command = commands.get()
        if command is None:
            break
        action = command.get("command")
        if action == "warm":
            try:
                ensure_model()
                warm_generation()
            except Exception as error:  # noqa: BLE001 - protocol boundary
                emit({"event": "error", "message": str(error)})
        elif action == "summarize":
            summarize(command)


def read_commands() -> None:
    try:
        for line in sys.stdin:
            try:
                command = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(command, dict):
                continue
            action = command.get("command")
            if action in {"warm", "summarize"}:
                try:
                    commands.put_nowait(command)
                except queue.Full:
                    emit({
                        "event": "error",
                        "requestId": str(command.get("requestId", "")),
                        "message": "The local summary queue is busy.",
                    })
            elif action == "cancel":
                request_id = str(command.get("requestId", ""))
                if request_id:
                    with cancel_lock:
                        cancelled.add(request_id)
            elif action == "shutdown":
                shutdown.set()
                break
    finally:
        commands.put(None)


def main() -> None:
    emit({"event": "booting", "model": MODEL_PATH})
    # MLX creates its default GPU stream on the importing/main thread. Keep
    # model loading and generation there; a small reader thread provides
    # prompt cancellation without running inference on an invalid stream.
    reader = threading.Thread(target=read_commands, name="mlx-summary-input", daemon=True)
    reader.start()
    try:
        worker()
    finally:
        shutdown.set()
        reader.join(timeout=1)


if __name__ == "__main__":
    main()
