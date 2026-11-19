import AVFoundation
@preconcurrency import Speech

/// The microphone of the thread composer and of New thread: speech turned into words on the
/// phone (on-device where the language allows), handed on as they are heard. Words never leave
/// the phone except as the message the person sends. Asks for speech recognition and the
/// microphone the first time.
@MainActor @Observable final class ComposerDictation {
    private(set) var listening = false
    /// Why dictation couldn't start, until the next try.
    private(set) var problem: String?
    private var audio: DictationAudio?

    /// Whether the mic can work here: a recogniser on this phone and no refusal of speech or
    /// microphone access. Where it can't, the keyboard's own dictation does the job.
    var available: Bool {
        guard let recognizer = SFSpeechRecognizer(), recognizer.supportsOnDeviceRecognition else { return false }
        let speech = SFSpeechRecognizer.authorizationStatus()
        let mic = AVAudioApplication.shared.recordPermission
        return speech != .denied && speech != .restricted && mic != .denied
    }

    /// Starts listening; `heard` gets everything said so far each time it grows.
    func start(heard: @escaping @MainActor (String) -> Void) async {
        guard !listening else { return }
        problem = nil
        guard await DictationPermission.request() else {
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
}

/// The system's speech and microphone prompts. Their answers arrive on a system queue, so
/// nothing here belongs to the main actor: a main-actor callback answered there stops the app.
enum DictationPermission {
    nonisolated static func request() async -> Bool {
        let speech = await withCheckedContinuation { (done: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { @Sendable status in done.resume(returning: status) }
        }
        guard speech == .authorized else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }
}

/// The audio engine and recognition task behind one dictation. The microphone's buffers arrive on
/// the audio thread and results on the recogniser's queue; everything else is started and stopped
/// from the main actor.
private final class DictationAudio: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let request = SFSpeechAudioBufferRecognitionRequest()
    private var task: SFSpeechRecognitionTask?

    func start(recognizer: SFSpeechRecognizer, update: @escaping @Sendable (String, Bool) -> Void) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        let input = engine.inputNode
        // The request takes buffers from the audio thread (Apple's documented use); this object
        // is the Sendable owner it is reached through.
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { @Sendable [self] buffer, _ in
            request.append(buffer)
        }
        engine.prepare()
        try engine.start()
        task = recognizer.recognitionTask(with: request) { @Sendable result, error in
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
