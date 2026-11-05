import AVFoundation
import Speech

/// The composer's microphone: speech turned into words on the phone (on-device where the language
/// allows), handed on as they are heard. Words never leave the phone except as the message the
/// person sends. Asks for the microphone and speech recognition the first time.
@MainActor @Observable final class ComposerDictation {
    private(set) var listening = false
    /// Why dictation couldn't start, until the next try.
    private(set) var problem: String?
    private var audio: DictationAudio?

    /// Starts listening; `heard` gets everything said so far each time it grows.
    func start(heard: @escaping @MainActor (String) -> Void) async {
        guard !listening else { return }
        problem = nil
        guard await Self.allowed() else {
            problem = "Allow the microphone and speech recognition in Settings to dictate."
            return
        }
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            problem = "Dictation isn't available right now."
            return
        }
        let audio = DictationAudio()
        do {
            try audio.start(recognizer: recognizer) { [weak self] words, ended in
                Task { @MainActor in
                    guard let self, self.audio === audio else { return }
                    if !words.isEmpty { heard(words) }
                    if ended { self.stop() }
                }
            }
        } catch {
            problem = "Dictation couldn't start."
            return
        }
        self.audio = audio
        listening = true
    }

    func stop() {
        audio?.stop()
        audio = nil
        listening = false
    }

    private static func allowed() async -> Bool {
        let speech = await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
            SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0 == .authorized) }
        }
        guard speech else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }
}

/// The audio engine and recognition task behind one dictation. The microphone's buffers arrive on
/// the audio thread; everything else is started and stopped from the main actor.
private final class DictationAudio: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let request = SFSpeechAudioBufferRecognitionRequest()
    private var task: SFSpeechRecognitionTask?

    func start(recognizer: SFSpeechRecognizer, update: @escaping @Sendable (String, Bool) -> Void) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        request.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        let input = engine.inputNode
        let request = request
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        try engine.start()
        task = recognizer.recognitionTask(with: request) { result, error in
            update(result?.bestTranscription.formattedString ?? "", error != nil || result?.isFinal == true)
        }
    }

    func stop() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request.endAudio()
        task?.cancel()
        task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
