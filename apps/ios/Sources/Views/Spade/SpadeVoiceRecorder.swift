import AVFoundation
import SwiftUI

/// A voice message for Spade, recorded on the phone as AAC (`audio/mp4`, which Spade stores and
/// iPhone and web both play) and staged like a picked file. The words are Spade's to hear: the
/// bridge asks Spade's transcription model when the person types none. Asks for the microphone
/// the first time; refused, it says where to allow it and the rest of the composer keeps working.
@MainActor @Observable final class SpadeVoiceRecorder {
    private(set) var recording = false
    /// When the current recording began, for its running length.
    private(set) var began: Date?
    /// Why recording can't start, until the next try; `settings` when Settings can fix it.
    private(set) var problem: (text: String, settings: Bool)?
    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var url: URL?
    /// Between a press and the microphone opening (the system's prompt may be up).
    @ObservationIgnored private var starting = false
    /// The press ended before the microphone opened: what opens is dropped.
    @ObservationIgnored private var stopAsked = false
    /// Recordings stop here: well inside Spade's 25 MB at this quality.
    static let longest: TimeInterval = 10 * 60
    /// A press shorter than this is a tap, not a recording.
    static let shortest: TimeInterval = 0.6
    private let staging: AttachmentStaging

    init(staging: AttachmentStaging = AttachmentStaging()) { self.staging = staging }

    /// Starts recording, asking for the microphone first if it never was.
    func start() async {
        guard !recording, !starting else { return }
        problem = nil
        starting = true
        stopAsked = false
        defer { starting = false }
        guard await Self.microphone() else {
            problem = ("Allow the microphone for ace in Settings to record a voice message.", true)
            return
        }
        // Let go while the prompt was up: nothing was meant to be recorded.
        guard !stopAsked else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ace-voice-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 22_050, AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .duckOthers])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            guard recorder.record(forDuration: Self.longest) else { throw CocoaError(.fileWriteUnknown) }
            self.recorder = recorder
            self.url = url
            began = Date()
            recording = true
        } catch {
            try? FileManager.default.removeItem(at: url)
            release()
            problem = ("Couldn't start recording. Try again.", false)
        }
    }

    /// Stops and stages the recording; nil when it was only a tap or couldn't be kept.
    func finish() async -> SpadeComposerPicks.Recording? {
        if starting { stopAsked = true }
        guard recording, let recorder, let url else { return nil }
        // Held past the longest, the recorder stopped itself there.
        let seconds = recorder.isRecording ? recorder.currentTime : Self.longest
        recorder.stop()
        reset()
        guard seconds >= Self.shortest else {
            try? FileManager.default.removeItem(at: url)
            problem = ("Hold the microphone to record, then let go.", false)
            return nil
        }
        let staging = staging
        let staged = await Task.detached(priority: .userInitiated) {
            try? staging.stage(moving: url, name: "Voice message.m4a", mimeType: "audio/mp4")
        }.value
        guard let staged else {
            try? FileManager.default.removeItem(at: url)
            problem = ("Couldn't keep the recording. Try again.", false)
            return nil
        }
        return .init(file: staged, seconds: seconds)
    }

    /// Stops and drops the recording.
    func cancel() {
        if starting { stopAsked = true }
        recorder?.stop()
        recorder?.deleteRecording()
        reset()
    }

    func clearProblem() { problem = nil }

    /// The system's microphone prompt, answered on a system queue: asked from outside the main
    /// actor, as `DictationPermission` asks it.
    nonisolated private static func microphone() async -> Bool { await AVAudioApplication.requestRecordPermission() }

    private func reset() {
        recorder = nil
        url = nil
        began = nil
        recording = false
        release()
    }
    private func release() { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
}

/// The mic in Send's place while the field is empty: hold to record, let go to keep it for the
/// message (Send or Discard then), drag away to drop it. VoiceOver's activate starts, and again
/// stops, as holding can't be done there.
struct SpadeMicButton: View {
    let recorder: SpadeVoiceRecorder
    let recorded: (SpadeComposerPicks.Recording) -> Void
    @State private var held = false
    @State private var dropping = false
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

    var body: some View {
        AceIcon(recorder.recording ? .record : .microphone, size: AceDesign.Size.icon, relativeTo: .body)
            .foregroundStyle(recorder.recording ? AceDesign.Surface.background : AceDesign.Ink.primary)
            .frame(width: AceDesign.Size.navButton, height: AceDesign.Size.navButton)
            .background(recorder.recording ? (dropping ? AceDesign.Ink.faint : AceDesign.Ink.accent) : .clear, in: Circle())
            .contentShape(Circle())
            .gesture(hold, isEnabled: !voiceOver)
            .accessibilityElement()
            .accessibilityLabel(recorder.recording ? "Stop recording" : "Record a voice message")
            .accessibilityHint(recorder.recording ? "" : "Hold to record, let go to keep it")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { toggle() }
            .accessibilityIdentifier("spade.mic")
            .sensoryFeedback(AceDesign.Haptic.send, trigger: recorder.recording)
    }

    private var hold: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { drag in
                if !held {
                    held = true
                    Task { await recorder.start() }
                }
                dropping = hypot(drag.translation.width, drag.translation.height) > AceDesign.Size.tap * 1.5
            }
            .onEnded { _ in
                held = false
                if dropping { dropping = false; recorder.cancel(); return }
                keep()
            }
    }
    private func toggle() {
        if recorder.recording { keep() } else { Task { await recorder.start() } }
    }
    private func keep() {
        Task { if let take = await recorder.finish() { recorded(take) } }
    }
}

/// A voice message in the chat: Play and Pause, its size from the row while it rests and the time
/// it is at while it plays (Spade's voice ref names no length). Nothing is read until Play: the
/// conversation's one `SpadeVoicePlayback` reads it then, and lets it go when it ends, when
/// another starts, or when the row leaves the screen.
struct SpadeVoicePlay: View {
    let voice: SpadeModel.Voice
    /// The recording's bytes; nil when it couldn't be read.
    let read: (String) async -> Data?
    var onAccent = false
    @Environment(\.spadeVoicePlayback) private var playback

    var body: some View {
        let state = playback?.state(voice.ref) ?? .resting
        HStack(spacing: AceDesign.Space.related) {
            Button { playback?.toggle(voice.ref, read: read) } label: {
                Group {
                    if state == .loading { ProgressView().controlSize(.small) }
                    else { AceIcon(state == .playing ? .pause : .play, size: AceDesign.Size.icon, relativeTo: .body) }
                }
                .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(playback == nil || state == .loading)
            .accessibilityLabel(state == .playing ? "Pause voice message" : "Play voice message")
            .accessibilityIdentifier("spade.voice.play")
            Text(line(state)).aceFont(AceDesign.TextRole.meta).monospacedDigit()
        }
        .foregroundStyle(onAccent ? AceDesign.Surface.background : AceDesign.Ink.primary)
        .padding(.trailing, AceDesign.Space.margin)
        .background(onAccent ? AceDesign.Ink.accent : AceDesign.Surface.fill, in: AceDesign.Shape.bubble)
        .onDisappear { playback?.leave(voice.ref) }
    }

    private func line(_ state: SpadeVoicePlayback.State) -> String {
        switch state {
        case .playing, .paused: SpadeComposerPicks.length(playback?.elapsed ?? 0)
        case let .failed(text): text
        case .loading, .resting:
            voice.bytes > 0
                ? "Voice message · \(ByteCountFormatter.string(fromByteCount: Int64(voice.bytes), countStyle: .file))"
                : "Voice message"
        }
    }
}

extension EnvironmentValues {
    /// The open conversation's voice playback; without one, Play is off.
    @Entry var spadeVoicePlayback: SpadeVoicePlayback? = nil
}

/// A conversation's voice messages, played one at a time: at most one recording is read and held,
/// and it goes when it ends, when another starts, or when its row leaves the screen.
@MainActor @Observable final class SpadeVoicePlayback {
    enum State: Equatable { case resting, loading, playing, paused, failed(String) }
    /// The recording held, by its ref.
    private(set) var current: String?
    private(set) var loading: String?
    private(set) var playing = false
    private(set) var elapsed: TimeInterval = 0
    /// Why a recording couldn't play, by ref, until it is tried again.
    private(set) var failures: [String: String] = [:]
    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private var ticking: Task<Void, Never>?
    @ObservationIgnored private var reading: Task<Void, Never>?

    func state(_ ref: String) -> State {
        if loading == ref { return .loading }
        if current == ref { return playing ? .playing : .paused }
        if let failure = failures[ref] { return .failed(failure) }
        return .resting
    }

    /// Play, Pause, or carry on from where it paused; another recording held is let go first.
    func toggle(_ ref: String, read: @escaping @MainActor (String) async -> Data?) {
        if current == ref, let player {
            if playing { player.pause(); stopTicking() } else { start(player) }
            return
        }
        release()
        failures[ref] = nil
        loading = ref
        reading = Task { [weak self] in
            let data = await read(ref)
            guard let self, !Task.isCancelled, self.loading == ref else { return }
            self.loading = nil
            guard let data else { self.failures[ref] = "Couldn't read it"; return }
            guard let made = try? AVAudioPlayer(data: data), made.duration > 0 else {
                self.failures[ref] = "Can't play on iPhone"
                return
            }
            self.player = made
            self.current = ref
            self.start(made)
        }
    }

    /// Its row left the screen: a recording it held, or was reading, goes.
    func leave(_ ref: String) {
        if current == ref || loading == ref { release() }
    }

    /// Lets go of whatever is held or being read.
    func release() {
        reading?.cancel()
        reading = nil
        loading = nil
        stopTicking()
        player?.stop()
        player = nil
        current = nil
        playing = false
        elapsed = 0
    }

    private func start(_ player: AVAudioPlayer) {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        guard player.play() else { release(); return }
        playing = true
        ticking?.cancel()
        ticking = Task { [weak self] in
            while !Task.isCancelled, let self, let held = self.player, held === player {
                self.elapsed = held.currentTime
                // Played to its end: nothing is kept.
                if !held.isPlaying { self.release(); return }
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
    }
    private func stopTicking() {
        ticking?.cancel()
        ticking = nil
        playing = false
        elapsed = player?.currentTime ?? 0
    }
}
