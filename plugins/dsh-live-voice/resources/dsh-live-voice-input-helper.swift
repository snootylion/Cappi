import AVFoundation
import Foundation
import Speech

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

private final class VoiceInputController: @unchecked Sendable {
    private let emitter = JsonEmitter()
    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var preRoll: [AVAudioPCMBuffer] = []
    private var preRollFrames: AVAudioFramePosition = 0
    private var speechActive = false
    private var sessionActive = false
    private var muted = false
    private var mode = "dictation"
    private var locale = "en-US"
    private var endTurnSeconds = 1.5
    private var lastSpeechAt = DispatchTime.now()
    private var lastTranscriptAt = DispatchTime.now()
    private var noiseFloor: Float = 0.003
    private var latestTranscript = ""
    private var largestTranscriptWordCount = 0
    // `endAudio()` can race Apple's final recognition callback. Both paths are
    // valid terminal signals, but the desktop must receive exactly one final
    // event for each utterance. Keep the gate separate from audio state so it
    // is safe across the audio tap and Speech callback queues.
    private let terminalEventLock = NSLock()
    private var finalEmittedForUtterance = false

    func handle(_ command: [String: Any]) {
        switch command["command"] as? String {
        case "start":
            mode = command["mode"] as? String ?? "dictation"
            locale = command["locale"] as? String ?? "en-US"
            muted = false
            let endTurnMs = command["endTurnMs"] as? Double ?? 1500
            endTurnSeconds = min(2.5, max(0.9, endTurnMs / 1000))
            requestPermissionsAndStart()
        case "stop":
            stop(reason: "requested")
        case "mute":
            setMuted(command["muted"] as? Bool ?? true)
        case "shutdown":
            stop(reason: "shutdown")
            exit(0)
        default:
            emitter.send(["event": "error", "message": "Unsupported voice helper command."])
        }
    }

    private func requestPermissionsAndStart() {
        guard !sessionActive else {
            emitter.send(["event": "ready", "mode": mode, "locale": locale])
            return
        }

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard let self else { return }
            guard status == .authorized else {
                self.emitter.send(["event": "error", "code": "speech-permission", "message": "Speech Recognition permission is required."])
                return
            }
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                guard granted else {
                    self.emitter.send(["event": "error", "code": "microphone-permission", "message": "Microphone permission is required."])
                    return
                }
                DispatchQueue.main.async { self.startCapture() }
            }
        }
    }

    private func startCapture() {
        guard !sessionActive else { return }
        let localeValue = Locale(identifier: locale)
        guard let recognizer = SFSpeechRecognizer(locale: localeValue), recognizer.isAvailable else {
            emitter.send(["event": "error", "code": "locale-unavailable", "message": "Apple Speech is unavailable for \(locale)."])
            return
        }
        guard recognizer.supportsOnDeviceRecognition else {
            emitter.send(["event": "error", "code": "on-device-unavailable", "message": "On-device Apple Speech is unavailable for \(locale)."])
            return
        }
        self.recognizer = recognizer

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            emitter.send(["event": "error", "code": "audio-format", "message": "The microphone did not provide a usable audio format."])
            return
        }
        do {
            // Keep the capture engine input-only. Enabling AVAudioEngine voice
            // processing creates a hidden downlink path; on some macOS audio
            // routes that path has no valid sample timestamp, repeatedly faults
            // the VoiceProcessor, and eventually stops microphone capture while
            // leaving the helper process alive.
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.consume(buffer)
            }
            engine.prepare()
            try engine.start()
            sessionActive = true
            emitter.send(["event": "ready", "mode": mode, "locale": locale, "sampleRate": format.sampleRate])
        } catch {
            emitter.send(["event": "error", "code": "audio-start", "message": error.localizedDescription])
            cleanupCapture()
        }
    }

    private func consume(_ source: AVAudioPCMBuffer) {
        guard sessionActive, !muted, let buffer = clone(source) else { return }
        let level = rootMeanSquare(buffer)
        let threshold = max(0.008, noiseFloor * 3.2)
        let isSpeech = level >= threshold

        if !speechActive {
            noiseFloor = max(0.0015, min(0.02, noiseFloor * 0.985 + level * 0.015))
            appendPreRoll(buffer)
            if isSpeech {
                beginUtterance()
            }
            return
        }

        request?.append(buffer)
        let now = DispatchTime.now()
        if isSpeech { lastSpeechAt = now }

        let silenceNanos = now.uptimeNanoseconds - lastSpeechAt.uptimeNanoseconds
        let transcriptIdleNanos = now.uptimeNanoseconds - lastTranscriptAt.uptimeNanoseconds
        let trimmedTranscript = latestTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        let acousticallyFinishedWithoutWords = trimmedTranscript.isEmpty && Double(silenceNanos) / 1_000_000_000 >= endTurnSeconds
        let transcriptFinished = !trimmedTranscript.isEmpty && Double(transcriptIdleNanos) / 1_000_000_000 >= max(1.5, endTurnSeconds)
        if acousticallyFinishedWithoutWords || transcriptFinished {
            finishUtterance()
        }
    }

    private func beginUtterance() {
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
        lastSpeechAt = .now()
        lastTranscriptAt = .now()
        for buffer in preRoll { nextRequest.append(buffer) }
        preRoll.removeAll(keepingCapacity: true)
        preRollFrames = 0
        emitter.send(["event": "speechStarted"])

        task = recognizer.recognitionTask(with: nextRequest) { [weak self] result, error in
            guard let self else { return }
            guard self.request === nextRequest else { return }
            if let result {
                let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
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
                        self.emitFinalOnce(text)
                    } else if changed {
                        self.emitter.send(["event": "partial", "text": text])
                    }
                }
                if result.isFinal { self.completeRecognition() }
            }
            if let error {
                let nsError = error as NSError
                if nsError.code != 216 && nsError.code != 301 {
                    self.emitter.send(["event": "recognitionWarning", "message": error.localizedDescription])
                }
                self.completeRecognition(emitFallback: true)
            }
        }
    }

    private func finishUtterance() {
        guard speechActive else { return }
        speechActive = false
        request?.endAudio()
        emitter.send(["event": "speechEnded"])
        emitFinalOnce(latestTranscript.trimmingCharacters(in: .whitespacesAndNewlines))
        completeRecognition()
    }

    private func completeRecognition(emitFallback: Bool = false) {
        if emitFallback && !latestTranscript.isEmpty {
            emitFinalOnce(latestTranscript.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        task?.cancel()
        task = nil
        request = nil
        speechActive = false
        latestTranscript = ""
        largestTranscriptWordCount = 0
    }

    private func emitFinalOnce(_ text: String) {
        guard !text.isEmpty else { return }
        terminalEventLock.lock()
        defer { terminalEventLock.unlock() }
        guard !finalEmittedForUtterance else { return }
        finalEmittedForUtterance = true
        emitter.send(["event": "final", "text": text])
    }

    private func recognizedWordCount(_ text: String) -> Int {
        text.split(whereSeparator: { character in
            !character.isLetter && !character.isNumber
        }).count
    }

    private func appendPreRoll(_ buffer: AVAudioPCMBuffer) {
        preRoll.append(buffer)
        preRollFrames += AVAudioFramePosition(buffer.frameLength)
        let maximumFrames = AVAudioFramePosition(buffer.format.sampleRate * 0.5)
        while preRollFrames > maximumFrames, !preRoll.isEmpty {
            preRollFrames -= AVAudioFramePosition(preRoll.removeFirst().frameLength)
        }
    }

    private func setMuted(_ nextMuted: Bool) {
        guard sessionActive else {
            muted = nextMuted
            emitter.send(["event": nextMuted ? "muted" : "unmuted"])
            return
        }
        guard muted != nextMuted else {
            emitter.send(["event": nextMuted ? "muted" : "unmuted"])
            return
        }
        muted = nextMuted
        task?.cancel()
        task = nil
        request = nil
        speechActive = false
        latestTranscript = ""
        preRoll.removeAll(keepingCapacity: true)
        preRollFrames = 0
        if !nextMuted {
            noiseFloor = 0.003
            lastSpeechAt = .now()
        }
        emitter.send(["event": nextMuted ? "muted" : "unmuted"])
    }

    private func stop(reason: String) {
        guard sessionActive || task != nil else {
            emitter.send(["event": "stopped", "reason": reason])
            return
        }
        if speechActive { finishUtterance() }
        task?.cancel()
        task = nil
        request = nil
        cleanupCapture()
        muted = false
        emitter.send(["event": "stopped", "reason": reason])
    }

    private func cleanupCapture() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        sessionActive = false
        speechActive = false
        preRoll.removeAll()
        preRollFrames = 0
    }

    private func clone(_ source: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: source.frameLength) else { return nil }
        copy.frameLength = source.frameLength
        let buffers = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        let sourceBuffers = UnsafeMutableAudioBufferListPointer(source.mutableAudioBufferList)
        for index in 0..<min(buffers.count, sourceBuffers.count) {
            guard let destination = buffers[index].mData, let origin = sourceBuffers[index].mData else { continue }
            memcpy(destination, origin, Int(sourceBuffers[index].mDataByteSize))
            buffers[index].mDataByteSize = sourceBuffers[index].mDataByteSize
        }
        return copy
    }

    private func rootMeanSquare(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var total: Float = 0
        for index in 0..<Int(buffer.frameLength) {
            let sample = channel[index]
            total += sample * sample
        }
        return sqrt(total / Float(buffer.frameLength))
    }
}

private let controller = VoiceInputController()
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
        DispatchQueue.main.async { controller.handle(command) }
    }
    DispatchQueue.main.async { controller.handle(["command": "shutdown"]) }
}
RunLoop.main.run()
