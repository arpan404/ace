import ActivityKit
import Foundation

/// One thread as the lock screen, the Live Activity and the widgets show it: its title, the
/// inbox row's status mark (from the bridge's row look; nothing here derives a status), and when
/// its live work started. No transcript text.
struct LockRow: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let hostId: String
    let title: String
    /// The row's status mark (`RowStatusMark` kind) and its colour; "none" draws nothing.
    let icon: String
    let tone: String
    var count: Int? = nil
    /// The state in a few words ("Needs approval"), for VoiceOver.
    let meaning: String
    /// Start of the live stretch, for the system's running time; nil when the row isn't working.
    var since: Date? = nil
    /// `ace://thread/<id>?machine=<host>`.
    let link: String
    let needsYou: Bool
}

/// The approval waiting longest, with the exact option ids the daemon offered for it, so the
/// Live Activity can answer it. The machine re-reads the request before answering (ADR 0012).
struct LockRequest: Codable, Hashable, Sendable {
    let hostId: String
    let threadId: String
    let interactionId: String
    let approve: String
    let deny: String
    /// "Claude Code wants to run a command".
    let sentence: String
    /// The command, or the request's one line.
    let detail: String
    let code: Bool
    let title: String
}

/// The person's agents across every paired machine, as one glance: how many need them, how many
/// work, and the most urgent threads. `current` is false whenever any machine is unreachable or
/// any row is a copy its machine hasn't confirmed; then the counts are the last known and nothing
/// may read as finished.
struct LockSummary: Codable, Hashable, Sendable {
    var needsYou: Int
    var working: Int
    /// Most urgent first: needs you, then working, then failed and unseen results.
    var rows: [LockRow]
    var request: LockRequest? = nil
    var current: Bool
    /// Something works, waits or needs the person, or its state can't be confirmed.
    var busy: Bool
    var updatedAt: Date

    /// How long a summary counts as current without an update; past it every surface says
    /// "as of" its time.
    static let freshFor: TimeInterval = 10 * 60

    static let empty = LockSummary(needsYou: 0, working: 0, rows: [], current: false, busy: false, updatedAt: .distantPast)

    /// "2 need you · 4 working", "4 working", "Nothing needs you". Without current state and with
    /// nothing known to be running, it asks to open ace rather than claim all is quiet.
    var headline: String {
        let needs = needsYou == 0 ? nil : "\(needsYou) need\(needsYou == 1 ? "s" : "") you"
        let work = working == 0 ? nil : "\(working) working"
        let parts = [needs, work].compactMap { $0 }
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        return current ? "Nothing needs you" : "Open ace to check"
    }
    /// The same, for VoiceOver.
    var spokenHeadline: String { current ? headline : "\(headline), as of \(updatedAt.formatted(date: .omitted, time: .shortened))" }

    /// The same summary with at most `limit` rows, for surfaces with less room.
    func limited(_ limit: Int) -> LockSummary {
        var copy = self
        copy.rows = Array(rows.prefix(limit))
        return copy
    }
    /// What changed for the person, ignoring when it was computed.
    func sameContent(as other: LockSummary) -> Bool {
        var a = self, b = other
        a.updatedAt = .distantPast; b.updatedAt = .distantPast
        return a == b
    }
}

/// The one Live Activity for all of the person's agents. Its content is a `LockSummary` with up
/// to three rows: plain JSON, so a push sent through ace's gateway can carry the same shape.
struct AgentsActivityAttributes: ActivityAttributes {
    typealias ContentState = LockSummary
    /// Activities have to carry something fixed; it records which build started it.
    var version = 1
}

/// The app-group file the widgets read. The app writes it whenever the inbox changes; it holds
/// titles, status marks and one-line requests only, never transcript text or credentials.
enum LockSnapshotStore {
    static let group = "group.app.ace.ios"
    static let file = "lock-screen.json"
    /// Bounded: a snapshot past this is ignored rather than read.
    static let maxBytes = 64 * 1024
    static let maxRows = 6

    static func url() -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appending(path: file)
    }
    static func read(from url: URL? = url()) -> LockSummary? {
        guard let url, let data = try? Data(contentsOf: url), data.count <= maxBytes else { return nil }
        return try? decoder.decode(LockSummary.self, from: data)
    }
    static func write(_ summary: LockSummary, to url: URL? = url()) {
        guard let url, let data = try? encoder.encode(summary.limited(maxRows)), data.count <= maxBytes else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    private static let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .millisecondsSince1970; return e }()
    private static let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .millisecondsSince1970; return d }()
}
