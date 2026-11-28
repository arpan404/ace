import AVFAudio

/// How one use wants the app's audio session set up (raw values, so the rule stays plain data).
struct AudioSessionSetup: Equatable, Sendable {
    let category: String
    let mode: String
    var options: UInt = 0
    /// A higher one wins while both hold the session: recording outranks playback.
    var rank = 0

    init(_ category: AVAudioSession.Category, _ mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions = [], rank: Int = 0) {
        self.category = category.rawValue
        self.mode = mode.rawValue
        self.options = options.rawValue
        self.rank = rank
    }

    /// Composer dictation: the microphone for speech, others ducked.
    static let dictation = AudioSessionSetup(.record, .measurement, options: .duckOthers, rank: 2)
    /// A Spade voice message being recorded.
    static let voiceRecording = AudioSessionSetup(.playAndRecord, .spokenAudio, options: [.defaultToSpeaker, .duckOthers], rank: 2)
    /// A Spade voice message being played.
    static let voicePlayback = AudioSessionSetup(.playback, .spokenAudio, rank: 1)
    /// The live browser page's sound, and its picture-in-picture (which needs the playback category).
    static let pageSound = AudioSessionSetup(.playback, .moviePlayback, rank: 1)
}

/// Who holds the app's one audio session, and what to do to it (pure). Each use claims the
/// session while it plays or records and releases it when done. The highest-ranked claim sets the
/// session up (the newest among equals), so a recording isn't cut off by page sound or its end;
/// the session goes inactive only once nobody holds it, then takes the idle setup, if any.
struct AudioSessionClaims {
    enum Apply: Equatable {
        /// Set the session up so, and make it active.
        case activate(AudioSessionSetup)
        /// Nobody holds it: let it go, then set the idle category, if any.
        case deactivate(idle: AudioSessionSetup?)
        /// Nobody holds it: only the category changes.
        case category(AudioSessionSetup)
        case none
    }
    private var claims: [(id: Int, setup: AudioSessionSetup)] = []
    private var idle: AudioSessionSetup?

    /// The claim that sets the session up now: the highest rank, the newest among equals.
    private var top: (id: Int, setup: AudioSessionSetup)? {
        claims.enumerated().max { a, b in
            a.element.setup.rank != b.element.setup.rank ? a.element.setup.rank < b.element.setup.rank : a.offset < b.offset
        }?.element
    }
    var winner: AudioSessionSetup? { top?.setup }
    /// Whether `id`'s claim is the one setting the session up.
    func wins(_ id: Int) -> Bool { top?.id == id }

    mutating func claim(_ id: Int, _ setup: AudioSessionSetup) -> Apply {
        claims.removeAll { $0.id == id }
        claims.append((id, setup))
        return wins(id) ? .activate(setup) : .none
    }
    mutating func release(_ id: Int) -> Apply {
        guard claims.contains(where: { $0.id == id }) else { return .none }
        let wasWinner = wins(id)
        claims.removeAll { $0.id == id }
        guard let next = winner else { return .deactivate(idle: idle) }
        // The one left on top sets the session up again; a claim beneath it changes nothing.
        return wasWinner ? .activate(next) : .none
    }
    /// The category the session keeps while nobody holds it.
    mutating func setIdle(_ setup: AudioSessionSetup) -> Apply {
        idle = setup
        return claims.isEmpty ? .category(setup) : .none
    }
}
