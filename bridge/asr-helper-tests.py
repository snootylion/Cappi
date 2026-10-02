#!/usr/bin/env python3
"""Focused compile and offline regression tests for asr-helper.swift.

The Apple Speech integration tests stream synthesized fixtures at the real-time
2048-byte/64 ms cadence and keep stdin open after trailing silence so a final
observed before EOF proves natural-silence completion. If a fixture is missing
on macOS, it is generated locally with ``say`` and ``afconvert``. Integration
tests are skipped with an actionable reason when those local tools are absent.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import wave

SOURCE = Path(__file__).with_name("asr-helper.swift")
FIXTURE_A = Path("/tmp/dsh-asr-a.wav")
FIXTURE_B = Path("/tmp/dsh-asr-b.wav")
FIXTURE_TEXT = {
    FIXTURE_A: "Please inspect the project",
    FIXTURE_B: "and explain how the application handles incoming messages",
}
DEFAULT_BINARY = Path("/tmp/dsh-watch-asr-tested")
SAMPLE_RATE = 16_000
FRAME_BYTES = 2_048
FRAME_SECONDS = FRAME_BYTES / 2 / SAMPLE_RATE
ONE_SECOND_SILENCE = bytes(SAMPLE_RATE * 2)
FOUR_SECONDS_SILENCE = bytes(SAMPLE_RATE * 2 * 4)


def compile_helper(binary: Path) -> None:
    subprocess.run(
        [
            "swiftc",
            "-O",
            str(SOURCE),
            "-o",
            str(binary),
            "-framework",
            "AVFoundation",
            "-framework",
            "Speech",
        ],
        check=True,
    )


def read_pcm(path: Path) -> bytes:
    with wave.open(str(path), "rb") as wav:
        assert wav.getnchannels() == 1, path
        assert wav.getsampwidth() == 2, path
        assert wav.getframerate() == SAMPLE_RATE, path
        return wav.readframes(wav.getnframes())


def ensure_speech_fixtures() -> None:
    missing = [path for path in FIXTURE_TEXT if not path.exists()]
    if not missing:
        return
    if sys.platform != "darwin":
        raise unittest.SkipTest("fixture generation requires macOS say and afconvert")
    say = shutil.which("say")
    afconvert = shutil.which("afconvert")
    if not say or not afconvert:
        raise unittest.SkipTest(
            "missing ASR fixtures; install/restore macOS say and afconvert to generate them"
        )

    voices = subprocess.run(
        [say, "-v", "?"], check=True, text=True, capture_output=True
    ).stdout.splitlines()
    voice_args = ["-v", "Karen"] if any(line.startswith("Karen ") for line in voices) else []
    for destination in missing:
        with tempfile.TemporaryDirectory(prefix="dsh-asr-fixture-") as temp_dir:
            source = Path(temp_dir) / "speech.aiff"
            converted = Path(temp_dir) / "speech.wav"
            subprocess.run(
                [say, *voice_args, "-o", str(source), FIXTURE_TEXT[destination]],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                [
                    afconvert,
                    "-f",
                    "WAVE",
                    "-d",
                    f"LEI16@{SAMPLE_RATE}",
                    str(source),
                    str(converted),
                ],
                check=True,
                capture_output=True,
            )
            read_pcm(converted)  # Validate format before publishing the fixture.
            os.replace(converted, destination)


def trim_to_edge_padding(pcm: bytes, padding_seconds: float = 0.1) -> bytes:
    """Trim synthetic edge silence while retaining fixed context padding."""
    samples = memoryview(pcm).cast("h")
    window = SAMPLE_RATE // 100  # 10 ms
    threshold = 250
    voiced_windows = []
    for start in range(0, len(samples), window):
        block = samples[start : start + window]
        if block and max(abs(int(value)) for value in block) >= threshold:
            voiced_windows.append((start, min(len(samples), start + window)))
    if not voiced_windows:
        raise AssertionError("fixture contains no detectable speech")
    padding = int(SAMPLE_RATE * padding_seconds)
    first = max(0, voiced_windows[0][0] - padding)
    last = min(len(samples), voiced_windows[-1][1] + padding)
    return pcm[first * 2 : last * 2]


def normalized_text(event: dict) -> str:
    return re.sub(r"[^a-z0-9]+", " ", event["text"].lower()).strip()


def stream_audio(
    binary: Path, audio: bytes, *, wait_before_eof: float = 1.2
) -> tuple[list[dict], list[dict], str, float]:
    """Stream audio and snapshot events before deliberately closing stdin."""
    process = subprocess.Popen(
        [str(binary), "--locale", "en-AU", "--end-turn-ms", "2200"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=False,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    assert process.stderr is not None

    condition = threading.Condition()
    events: list[dict] = []
    parse_errors: list[str] = []
    stderr_chunks: list[bytes] = []

    def read_stdout() -> None:
        for raw_line in iter(process.stdout.readline, b""):
            try:
                event = json.loads(raw_line)
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                with condition:
                    parse_errors.append(f"{error}: {raw_line!r}")
                    condition.notify_all()
                continue
            with condition:
                events.append(event)
                condition.notify_all()

    def read_stderr() -> None:
        stderr_chunks.append(process.stderr.read())

    stdout_thread = threading.Thread(target=read_stdout, daemon=True)
    stderr_thread = threading.Thread(target=read_stderr, daemon=True)
    stdout_thread.start()
    stderr_thread.start()

    try:
        ready_deadline = time.monotonic() + 10
        with condition:
            while not any(event.get("event") == "ready" for event in events):
                remaining = ready_deadline - time.monotonic()
                if remaining <= 0 or parse_errors or process.poll() is not None:
                    raise AssertionError(
                        f"helper did not become ready: events={events}, parse_errors={parse_errors}"
                    )
                condition.wait(timeout=remaining)

        for offset in range(0, len(audio), FRAME_BYTES):
            process.stdin.write(audio[offset : offset + FRAME_BYTES])
            process.stdin.flush()
            time.sleep(FRAME_SECONDS)

        # Keep the stream live: finals in this snapshot cannot be EOF-driven.
        time.sleep(wait_before_eof)
        with condition:
            before_eof = list(events)
        process.stdin.close()
        process.stdin = None
        eof_started = time.monotonic()
        process.wait(timeout=8)
    except BaseException:
        process.kill()
        process.wait()
        raise
    finally:
        stdout_thread.join(timeout=2)
        stderr_thread.join(timeout=2)
        process.stdout.close()
        process.stderr.close()

    eof_elapsed = time.monotonic() - eof_started
    if parse_errors:
        raise AssertionError(f"invalid JSONL from helper: {parse_errors}")
    return list(events), before_eof, b"".join(stderr_chunks).decode(), eof_elapsed


class ASRHelperTests(unittest.TestCase):
    binary: Path

    @classmethod
    def setUpClass(cls) -> None:
        cls.binary = Path(os.environ.get("ASR_HELPER_BINARY", DEFAULT_BINARY))
        compile_helper(cls.binary)

    def test_compiles_and_documents_default_threshold(self) -> None:
        result = subprocess.run(
            [str(self.binary), "--help"], check=True, text=True, capture_output=True
        )
        self.assertIn("default: 2200", result.stdout)

    def test_segmentation_and_final_callback_keep_fallbacks(self) -> None:
        source = SOURCE.read_text()
        self.assertNotIn("lastSpeechAt", source)
        self.assertRegex(
            source,
            re.compile(
                r"audioSeconds\s*\+=\s*Double\(buffer\.frameLength\)\s*/\s*buffer\.format\.sampleRate"
            ),
        )
        self.assertIn("silenceSeconds >= endTurnSeconds", source)
        self.assertIn("Double(transcriptIdleNanos) / 1_000_000_000 >= 0.6", source)
        self.assertIn(
            "if result.isFinal { self.completeRecognitionLocked(emitFallback: true) }",
            source,
        )

    @unittest.skipUnless(sys.platform == "darwin", "Apple Speech requires macOS")
    def test_natural_silence_emits_complete_final_before_eof(self) -> None:
        ensure_speech_fixtures()
        first = trim_to_edge_padding(read_pcm(FIXTURE_A))
        second = trim_to_edge_padding(read_pcm(FIXTURE_B))
        # The two 100 ms edge pads make the one-second gap approximately 1.2 s,
        # below the 2.2 s turn timeout. Four trailing seconds must finish it.
        audio = first + ONE_SECOND_SILENCE + second + FOUR_SECONDS_SILENCE
        events, before_eof, stderr, eof_elapsed = stream_audio(self.binary, audio)

        errors = [event for event in events if event.get("event") == "error"]
        self.assertFalse(errors, f"ASR errors: {errors}; stderr={stderr!r}")
        pre_eof_finals = [event for event in before_eof if event.get("event") == "final"]
        finals = [event for event in events if event.get("event") == "final"]
        self.assertEqual(1, len(pre_eof_finals), (before_eof, stderr))
        self.assertEqual(1, len(finals), (events, stderr))
        normalized = normalized_text(finals[0])
        self.assertTrue(normalized.endswith("incoming messages"), finals[0])
        for phrase in ("please inspect the project", "explain how the application handles"):
            self.assertIn(phrase, normalized, finals[0])

        ended = [event for event in events if event.get("event") == "speechEnded"]
        self.assertEqual(1, len(ended), events)
        self.assertEqual(finals[0]["utteranceId"], ended[0]["utteranceId"])
        self.assertEqual("stopped", events[-1].get("event"), events)
        self.assertEqual("eof", events[-1].get("reason"), events[-1])
        self.assertLess(eof_elapsed, 2.0, eof_elapsed)

    @unittest.skipUnless(sys.platform == "darwin", "Apple Speech requires macOS")
    def test_four_second_gap_emits_two_complete_finals_before_eof(self) -> None:
        ensure_speech_fixtures()
        first = trim_to_edge_padding(read_pcm(FIXTURE_A))
        second = trim_to_edge_padding(read_pcm(FIXTURE_B))
        audio = first + FOUR_SECONDS_SILENCE + second + FOUR_SECONDS_SILENCE
        events, before_eof, stderr, _ = stream_audio(self.binary, audio)

        errors = [event for event in events if event.get("event") == "error"]
        self.assertFalse(errors, f"ASR errors: {errors}; stderr={stderr!r}")
        pre_eof_finals = [event for event in before_eof if event.get("event") == "final"]
        finals = [event for event in events if event.get("event") == "final"]
        self.assertEqual(2, len(pre_eof_finals), (before_eof, stderr))
        self.assertEqual(2, len(finals), (events, stderr))
        self.assertEqual(2, len({event["utteranceId"] for event in finals}), finals)

        first_text, second_text = map(normalized_text, finals)
        self.assertIn("please inspect the project", first_text, finals[0])
        self.assertTrue(first_text.endswith("project"), finals[0])
        self.assertIn("explain how the application handles", second_text, finals[1])
        self.assertTrue(second_text.endswith("incoming messages"), finals[1])
        ended_ids = {
            event["utteranceId"]
            for event in events
            if event.get("event") == "speechEnded"
        }
        self.assertEqual({event["utteranceId"] for event in finals}, ended_ids)


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--binary")
    known, remaining = parser.parse_known_args()
    if known.binary:
        os.environ["ASR_HELPER_BINARY"] = known.binary
    unittest.main(argv=[sys.argv[0], *remaining], verbosity=2)


if __name__ == "__main__":
    main()
