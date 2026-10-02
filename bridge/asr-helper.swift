// watch-asr — stdin PCM → Apple on-device speech → JSONL events.
//
// A Node bridge streams live microphone PCM (signed 16-bit LE, mono, 16000 Hz)
// into this process on stdin. This helper segments the stream into utterances
// with an adaptive noise-floor VAD, runs Apple Speech on-device recognition
// per utterance, and writes newline-delimited JSON events to stdout
// (flushed per line). Diagnostics go to stderr.
//
// Exit codes: 0 normal, 2 permission denied, 3 fatal config.
//
// VAD / utterance / exactly-once logic is ported faithfully from the DSH live
// voice input helper (dsh-live-voice-input-helper.swift).

import AVFoundation
import Foundation
import Speech

// MARK: - JSON output

private final class JsonEmitter: @unchecked Sendable {
    private let lock = NSLock()

    func send(_ payload: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let line = String(data: data, encoding: .utf8) else { return }
        lock.lock()
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
        lock.unlock()
    }
}

private func emitStderr(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

private let usageText = """
usage: watch-asr [--locale <identifier>] [--end-turn-ms <int>]

Reads raw PCM (signed 16-bit LE, mono, 16000 Hz) from stdin and emits
newline-delimited JSON speech-recognition events on stdout.

options:
  --locale <identifier>   BCP-47 locale for Apple Speech (default: en-AU)
  --end-turn-ms <int>     utterance end-turn timeout in milliseconds,
                          clamped to 900-2500 (default: 2200)
  -h, --help              show this help and exit
"""

// MARK: - Controller

private final class ASRController: @unchecked Sendable {
    private let emitter = JsonEmitter()

    // Guards all shared recognition / VAD state across the stdin reader
    // thread, Speech callback queues, and the signal handler.
    private let stateLock = NSLock()
    // `endAudio()` can race Apple's final recognition callback; the desktop
    // must receive exactly one final event per utterance. Same gate pattern
    // as the reference implementation.
    private let terminalEventLock = NSLock()
    private var finalEmittedForUtterance = false

    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    private let audioFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16000,
        channels: 1,
        interleaved: false
    )
    private var preRoll: [AVAudioPCMBuffer] = []
    private var preRollFrames: AVAudioFramePosition = 0

    private var sessionActive = false
    private var speechActive = false
    private var stoppedEmitted = false

    private let locale: String
    private let endTurnSeconds: Double

    private var noiseFloor: Float = 0.003
    // Measure silence on the PCM clock, not wall time: HTTP/stdin arrive in bursts.
    private var audioSeconds = 0.0
    private var lastSpeechAudioSeconds = 0.0
    private var lastTranscriptAt = DispatchTime.now()
    private var latestTranscript = ""
    private var largestTranscriptWordCount = 0
    private var currentUtteranceId = ""

    private let authLock = NSLock()
    private var authSettled = false

    init(locale: String, endTurnMs: Int) {
        self.locale = locale
        let clamped = min(2500, max(900, endTurnMs))
        self.endTurnSeconds = Double(clamped) / 1000.0
    }

    // MARK: Authorization & startup

    func start() {
        guard audioFormat != nil else {
            emitter.send([
                "event": "error",
                "code": "audio-format",
                "message": "Unable to create the 16 kHz mono float32 audio format.",
            ])
            exit(3)
        }

        // The authorization callback may never fire while a TCC prompt is
        // pending; treat 30 s of silence as denied.
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 30) { [weak self] in
            self?.settleAuthorization(.notDetermined, timedOut: true)
        }
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            self?.settleAuthorization(status, timedOut: false)
        }
    }

    private func settleAuthorization(_ status: SFSpeechRecognizerAuthorizationStatus, timedOut: Bool) {
        authLock.lock()
        if authSettled {
            authLock.unlock()
            return
        }
        authSettled = true
        authLock.unlock()

        guard status == .authorized else {
            emitter.send([
                "event": "error",
                "code": "speech-permission",
                "message": timedOut
                    ? "Speech Recognition permission request timed out."
                    : "Speech Recognition permission is required.",
            ])
            exit(2)
        }

        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
              recognizer.isAvailable else {
            emitter.send([
                "event": "error",
                "code": "locale-unavailable",
                "message": "Apple Speech is unavailable for \(locale).",
            ])
            exit(3)
        }
        guard recognizer.supportsOnDeviceRecognition else {
            emitter.send([
                "event": "error",
                "code": "on-device-unavailable",
                "message": "On-device Apple Speech is unavailable for \(locale).",
            ])
            exit(3)
        }

        stateLock.lock()
        self.recognizer = recognizer
        sessionActive = true
        stateLock.unlock()

        emitter.send(["event": "ready", "sampleRate": 16000])
        startAudioReader()
    }

    // MARK: Stdin PCM reader

    private func startAudioReader() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.readAudioFromStdin()
        }
    }

    private func readAudioFromStdin() {
        let frameBytes = 2048 // 1024 samples * 2 bytes (s16le mono @ 16 kHz)
        let handle = FileHandle.standardInput
        var pending = Data()

        readLoop: while true {
            let chunk: Data?
            do {
                chunk = try handle.read(upToCount: 64 * 1024)
            } catch {
                emitStderr("watch-asr: stdin read failed: \(error.localizedDescription)")
                chunk = nil
            }
            guard let data = chunk, !data.isEmpty else { break readLoop } // EOF or read error
            pending.append(data)
            while pending.count >= frameBytes {
                let frame = Data(pending.prefix(frameBytes))
                pending.removeFirst(frameBytes)
                processFrame(frame)
            }
        }

        if pending.count >= 2 {
            processFrame(Data(pending))
        } else if !pending.isEmpty {
            emitStderr("watch-asr: dropping 1 trailing byte of stdin input")
        }
        finishAtEOF()
    }

    private func processFrame(_ bytes: Data) {
        guard let format = audioFormat else {
            emitter.send([
                "event": "error",
                "code": "audio-format",
                "message": "Unable to create the 16 kHz mono float32 audio format.",
            ])
            exit(3)
        }
        let sampleCount = bytes.count / 2
        guard sampleCount > 0 else { return }

        var samples = [Float](repeating: 0, count: sampleCount)
        let base = bytes.startIndex
        var sumSquares: Float = 0
        for index in 0..<sampleCount {
            let offset = base + index * 2
            let raw = UInt16(bytes[offset]) | (UInt16(bytes[offset + 1]) << 8)
            let value = Float(Int16(bitPattern: raw)) / 32768.0
            samples[index] = value
            sumSquares += value * value
        }
        let level = sqrt(sumSquares / Float(sampleCount))

        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sampleCount)),
              let channel = buffer.floatChannelData?[0] else {
            emitter.send([
                "event": "error",
                "code": "audio-format",
                "message": "Unable to allocate an audio processing buffer.",
            ])
            exit(3)
        }
        buffer.frameLength = AVAudioFrameCount(sampleCount)
        for (index, value) in samples.enumerated() {
            channel[index] = value
        }

        stateLock.lock()
        consumeLocked(buffer, level: level)
        stateLock.unlock()
    }

    // MARK: VAD (port of the reference `consume`)

    private func consumeLocked(_ buffer: AVAudioPCMBuffer, level: Float) {
        guard sessionActive, !stoppedEmitted else { return }
        // Advance by decoded PCM frames rather than process arrival time. The
        // bridge can deliver several audio frames in one HTTP/stdin burst.
        audioSeconds += Double(buffer.frameLength) / buffer.format.sampleRate
        let threshold = max(0.008, noiseFloor * 3.2)
        let isSpeech = level >= threshold

        if !speechActive {
            noiseFloor = max(0.0015, min(0.02, noiseFloor * 0.985 + level * 0.015))
            appendPreRollLocked(buffer)
            if isSpeech {
                beginUtteranceLocked()
            }
            return
        }

        request?.append(buffer)
        let now = DispatchTime.now()
        if isSpeech { lastSpeechAudioSeconds = audioSeconds }

        let silenceSeconds = max(0, audioSeconds - lastSpeechAudioSeconds)
        let transcriptIdleNanos = now.uptimeNanoseconds - lastTranscriptAt.uptimeNanoseconds
        let trimmedTranscript = latestTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        let acousticallyFinishedWithoutWords = trimmedTranscript.isEmpty
            && silenceSeconds >= endTurnSeconds
        // Recognition updates can stall while the user is still speaking.
        // Only real acoustic silence may end a spoken turn.
        let transcriptFinished = !trimmedTranscript.isEmpty
            && silenceSeconds >= endTurnSeconds
            && Double(transcriptIdleNanos) / 1_000_000_000 >= 0.6
        if acousticallyFinishedWithoutWords || transcriptFinished {
            finishUtteranceLocked()
        }
    }

    private func appendPreRollLocked(_ buffer: AVAudioPCMBuffer) {
        preRoll.append(buffer)
        preRollFrames += AVAudioFramePosition(buffer.frameLength)
        let maximumFrames = AVAudioFramePosition(buffer.format.sampleRate * 0.5)
        while preRollFrames > maximumFrames, !preRoll.isEmpty {
            preRollFrames -= AVAudioFramePosition(preRoll.removeFirst().frameLength)
        }
    }

    // MARK: Utterance lifecycle (port of the reference `beginUtterance` / `finishUtterance`)

    private func beginUtteranceLocked() {
        guard task == nil, let recognizer else { return }
        let nextRequest = SFSpeechAudioBufferRecognitionRequest()
        nextRequest.requiresOnDeviceRecognition = true
        nextRequest.shouldReportPartialResults = true
        nextRequest.taskHint = .dictation
        request = nextRequest
        latestTranscript = ""
        largestTranscriptWordCount = 0
        terminalEventLock.lock()
        finalEmittedForUtterance = false
        terminalEventLock.unlock()
        speechActive = true
        lastSpeechAudioSeconds = audioSeconds
        lastTranscriptAt = .now()
        let utteranceId = UUID().uuidString
        currentUtteranceId = utteranceId
        for buffer in preRoll {
            nextRequest.append(buffer)
        }
        preRoll.removeAll(keepingCapacity: true)
        preRollFrames = 0
        emitter.send(["event": "speechStarted", "utteranceId": utteranceId])

        task = recognizer.recognitionTask(with: nextRequest) { [weak self] result, error in
            guard let self else { return }
            self.stateLock.lock()
            defer { self.stateLock.unlock() }
            guard self.request === nextRequest else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    let changed = text != self.latestTranscript
                    if changed {
                        self.latestTranscript = text
                        let wordCount = self.recognizedWordCount(text)
                        if wordCount > self.largestTranscriptWordCount {
                            self.largestTranscriptWordCount = wordCount
                            self.lastTranscriptAt = .now()
                        }
                    }
                    if result.isFinal {
                        self.emitFinalOnce(text, utteranceId: utteranceId)
                    } else if changed {
                        self.emitter.send([
                            "event": "partial",
                            "text": text,
                            "utteranceId": utteranceId,
                        ])
                    }
                }
                // Apple can finish an ended audio request with an empty
                // bestTranscription even after delivering useful partials.
                // Route every final callback through the exactly-once fallback
                // before clearing latestTranscript.
                if result.isFinal { self.completeRecognitionLocked(emitFallback: true) }
            }
            if let error {
                let nsError = error as NSError
                // 216 / 301 are cancellation noise from Apple's recognizer.
                if nsError.code != 216 && nsError.code != 301 {
                    emitStderr("watch-asr: recognition warning: \(error.localizedDescription)")
                }
                self.completeRecognitionLocked(emitFallback: true)
            }
        }
    }

    private func finishUtteranceLocked() {
        guard speechActive else { return }
        speechActive = false
        request?.endAudio()
        let utteranceId = currentUtteranceId
        emitter.send(["event": "speechEnded", "utteranceId": utteranceId])
        // endAudio asks Apple for its final result. Cancelling immediately here
        // used to submit only the partial transcript and lose trailing words.
        let finishingRequest = request
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let self else { return }
            self.stateLock.lock()
            defer { self.stateLock.unlock() }
            guard self.request === finishingRequest, self.currentUtteranceId == utteranceId else { return }
            self.completeRecognitionLocked(emitFallback: true)
        }
    }

    private func completeRecognitionLocked(emitFallback: Bool = false) {
        if emitFallback && !latestTranscript.isEmpty {
            emitFinalOnce(latestTranscript.trimmingCharacters(in: .whitespacesAndNewlines),
                          utteranceId: currentUtteranceId)
        }
        task?.cancel()
        task = nil
        request = nil
        speechActive = false
        latestTranscript = ""
        largestTranscriptWordCount = 0
    }

    private func emitFinalOnce(_ text: String, utteranceId: String) {
        guard !text.isEmpty else { return }
        terminalEventLock.lock()
        defer { terminalEventLock.unlock() }
        guard !finalEmittedForUtterance else { return }
        finalEmittedForUtterance = true
        emitter.send(["event": "final", "text": text, "utteranceId": utteranceId])
    }

    private func recognizedWordCount(_ text: String) -> Int {
        text.split(whereSeparator: { character in
            !character.isLetter && !character.isNumber
        }).count
    }

    // MARK: Termination

    private func finishAtEOF() {
        stateLock.lock()
        if speechActive { finishUtteranceLocked() }
        stateLock.unlock()
        // Allow final recognition (or the bounded fallback above) to complete.
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.1) { [weak self] in
            guard let self else { exit(0) }
            self.stateLock.lock()
            self.completeRecognitionLocked(emitFallback: true)
            self.emitStoppedLocked(reason: "eof")
            self.stateLock.unlock()
            exit(0)
        }
    }

    func handleTermination() {
        stateLock.lock()
        if speechActive { finishUtteranceLocked() }
        emitStoppedLocked(reason: "shutdown")
        stateLock.unlock()
        exit(0)
    }

    private func emitStoppedLocked(reason: String) {
        guard !stoppedEmitted else { return }
        stoppedEmitted = true
        emitter.send(["event": "stopped", "reason": reason])
    }
}

// MARK: - Argument parsing

private func failWithUsage(_ message: String) -> Never {
    emitStderr("watch-asr: \(message)")
    emitStderr(usageText)
    exit(3)
}

private func parseArguments() -> (locale: String, endTurnMs: Int) {
    var locale = "en-AU"
    var endTurnMs = 2200
    let arguments = Array(CommandLine.arguments.dropFirst())
    var index = 0
    while index < arguments.count {
        switch arguments[index] {
        case "--locale":
            guard index + 1 < arguments.count else {
                failWithUsage("--locale requires a value")
            }
            locale = arguments[index + 1]
            index += 2
        case "--end-turn-ms":
            guard index + 1 < arguments.count else {
                failWithUsage("--end-turn-ms requires a value")
            }
            guard let value = Int(arguments[index + 1]) else {
                failWithUsage("--end-turn-ms requires an integer value, got '\(arguments[index + 1])'")
            }
            endTurnMs = value
            index += 2
        case "-h", "--help":
            print(usageText)
            exit(0)
        default:
            failWithUsage("unknown argument: \(arguments[index])")
        }
    }
    return (locale, endTurnMs)
}

// MARK: - Entry point

private let config = parseArguments()

// Ignore SIGPIPE (closed stdout) and make SIGTERM observable via dispatch.
signal(SIGPIPE, SIG_IGN)
signal(SIGTERM, SIG_IGN)
private let terminationSource = DispatchSource.makeSignalSource(
    signal: SIGTERM,
    queue: DispatchQueue.global(qos: .userInitiated)
)

private let controller = ASRController(locale: config.locale, endTurnMs: config.endTurnMs)
terminationSource.setEventHandler { [weak controller] in
    controller?.handleTermination()
}
terminationSource.resume()

controller.start()
RunLoop.main.run()
