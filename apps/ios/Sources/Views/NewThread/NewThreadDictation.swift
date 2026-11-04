import AVFoundation
import Observation
import Speech

/// New thread's mic: speech recognised on the phone when it can be, written into the field as it
/// is heard. Without permission or an on-device recogniser the mic stays out of the way and the
/// keyboard's own dictation does the job: no screen of its own, no explanation.
@MainActor @Observable final class NewThreadDictation {
    private(set) var listening = false
    /// Why it stopped early, in one line; nil while it works.
    private(set) var problem: String?
    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private let recognizer = SFSpeechRecognizer()

    /// The mic shows only where it can work: a recogniser that runs on the phone and no refusal
    /// of speech or microphone access.
    var available: Bool {
        guard let recognizer, recognizer.supportsOnDeviceRecognition else { return false }
        let speech = SFSpeechRecognizer.authorizationStatus()
        let mic = AVAudioApplication.shared.recordPermission
        return speech != .denied && speech != .restricted && mic != .denied
    }

    /// Starts listening; `heard` gets the whole transcript so far each time it grows.
    func start(heard: @escaping (String) -> Void) async {
        guard !listening, let recognizer else { return }
        problem = nil
        guard await Self.authorized() else { return }
        let session = AVAudioSession.sharedInstance()
        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        do {
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let input = engine.inputNode
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buffer, _ in request.append(buffer) }
            engine.prepare()
            try engine.start()
        } catch {
            problem = "The microphone isn't available right now."
            try? session.setActive(false)
            return
        }
        self.engine = engine
        self.request = request
        listening = true
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let final = result?.isFinal ?? false
            Task { @MainActor in
                guard let self, self.listening else { return }
                if let text { heard(text) }
                if final || error != nil { self.stop() }
            }
        }
    }
    func stop() {
        guard listening else { return }
        listening = false
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.finish()
        engine = nil; request = nil; task = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Asks for speech and then microphone access the first time (the system's own prompts).
    private static func authorized() async -> Bool {
        let speech: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { done in
            SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) }
        }
        guard speech == .authorized else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }
}
