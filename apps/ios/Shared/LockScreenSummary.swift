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

/// The person's agents across every paired machine, as one glance: how many are in each state
/// of the design language's status table (each row's state comes from the bridge, never derived
/// here), and the most urgent threads.
///
/// `live` is true when the counts come from at least one connected machine at `updatedAt`; false
/// means they are the last known and every surface says "as of" their time. `current` is stricter:
/// every paired machine is connected and every row confirmed, so only then may anything read as
/// quiet ("Nothing needs you") or offer Allow and Deny.
struct LockSummary: Codable, Hashable, Sendable {
    var needsYou: Int
    var working: Int
    var failed = 0
    /// Any other wait: the queue, a recovery to review, the network or provider.
    var waiting = 0
    /// Held at a usage limit.
    var limited = 0
    /// Only background commands run.
    var background = 0
    /// Most urgent first: needs you, failed, working, waiting, limited, background, then unseen results.
    var rows: [LockRow]
    var request: LockRequest? = nil
    var current: Bool
    var live: Bool
    /// Paired machines that couldn't be reached; their threads aren't counted.
    var offline = 0
    /// Something works, waits or needs the person, or its state can't be confirmed.
    var busy: Bool
    /// When the counts were last confirmed by a connected machine.
    var updatedAt: Date

    init(needsYou: Int, working: Int, failed: Int = 0, waiting: Int = 0, limited: Int = 0, background: Int = 0,
         rows: [LockRow], request: LockRequest? = nil, current: Bool, live: Bool? = nil, offline: Int = 0,
         busy: Bool, updatedAt: Date) {
        self.needsYou = needsYou; self.working = working; self.failed = failed; self.waiting = waiting
        self.limited = limited; self.background = background; self.rows = rows; self.request = request
        self.current = current; self.live = live ?? current; self.offline = offline; self.busy = busy; self.updatedAt = updatedAt
    }

    /// How long a summary counts as current without an update; past it every surface says
    /// "as of" its time. ace refreshes it every minute while it runs, so this is the most a
    /// suspended app's last word can stay on screen looking fresh.
    static let freshFor: TimeInterval = 3 * 60

    static let empty = LockSummary(needsYou: 0, working: 0, rows: [], current: false, busy: false, updatedAt: .distantPast)

    /// The counts in words, most urgent first, at most three: "2 need you · 3 working · 5 waiting".
    var parts: [String] {
        let all: [(Int, String)] = [
            (needsYou, needsYou == 1 ? "needs you" : "need you"), (failed, "failed"), (working, "working"),
            (waiting, "waiting"), (limited, "limited"), (background, "in background"),
        ]
        return all.filter { $0.0 > 0 }.prefix(3).map { "\($0.0) \($0.1)" }
    }
    /// The parts joined; with nothing to count, "Nothing needs you" only when every machine is
    /// confirmed, the machines out of reach when some others answered, else a nudge to open ace.
    var headline: String {
        let parts = parts
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        if current { return "Nothing needs you" }
        if live, offline > 0 { return offlineWords }
        return "Open ace to check"
    }
    /// "1 machine offline", "2 machines offline".
    var offlineWords: String { "\(offline) machine\(offline == 1 ? "" : "s") offline" }
    /// Whether the content is to be read "as of" its time: the last known, or past its stale date.
    func asOf(stale: Bool) -> Bool { stale || !live }
    /// What sits after the headline: "as of 7:26 AM" when it isn't fresh, the machines out of
    /// reach when the headline counts only the others, else `fresh`.
    func note(stale: Bool, fresh: String) -> String {
        if asOf(stale: stale) { return "as of \(updatedAt.formatted(date: .omitted, time: .shortened))" }
        if offline > 0, headline != offlineWords { return offlineWords }
        return fresh
    }
    /// The same, for VoiceOver.
    func spokenHeadline(stale: Bool) -> String {
        let note = note(stale: stale, fresh: "")
        return note.isEmpty ? headline : "\(headline), \(note)"
    }

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

    private enum Keys: String, CodingKey {
        case needsYou, working, failed, waiting, limited, background, rows, request, current, live, offline, busy, updatedAt
    }
    /// Activities and snapshots from earlier builds lack the newer counts; they decode as zero,
    /// and their content as live only if it was current.
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        needsYou = try box.decode(Int.self, forKey: .needsYou)
        working = try box.decode(Int.self, forKey: .working)
        failed = try box.decodeIfPresent(Int.self, forKey: .failed) ?? 0
        waiting = try box.decodeIfPresent(Int.self, forKey: .waiting) ?? 0
        limited = try box.decodeIfPresent(Int.self, forKey: .limited) ?? 0
        background = try box.decodeIfPresent(Int.self, forKey: .background) ?? 0
        rows = try box.decode([LockRow].self, forKey: .rows)
        request = try box.decodeIfPresent(LockRequest.self, forKey: .request)
        current = try box.decode(Bool.self, forKey: .current)
        live = try box.decodeIfPresent(Bool.self, forKey: .live) ?? current
        offline = try box.decodeIfPresent(Int.self, forKey: .offline) ?? 0
        busy = try box.decode(Bool.self, forKey: .busy)
        updatedAt = try box.decode(Date.self, forKey: .updatedAt)
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
