import ActivityKit
import Foundation

/// One paired machine's Live Activity (ADR 0223). Its daemon starts, updates and ends it by push
/// through ace's gateway; the app, while open, may write the same state locally with rows added.
/// The content is exactly what the gateway sends: counts, a phase, a sequence and integer times,
/// so no date strategy is involved. Every word on screen comes from the widget or the app-group
/// snapshot, never from a push.
struct MachineActivityAttributes: ActivityAttributes {
    /// Which paired machine, as a phone-chosen slot (0...15) with no other meaning. The widget
    /// maps it to the machine's name and rows through the app-group snapshot.
    var slot: Int
    var version = 1

    struct ContentState: Codable, Hashable, Sendable {
        /// Strictly increasing per machine; the snapshot's rows show only beside the same `seq`.
        var seq: Int
        /// Seconds since 1970, when the daemon (or the app, for a local update) computed it.
        var at: Int
        /// "busy" or "settled"; anything else reads as busy.
        var phase: String
        var needsYou: Int
        var working: Int
        var failed: Int
        var waiting: Int
        var limited: Int
        var background: Int
        /// Finished since the activity started; shown on end.
        var done: Int
        /// Local updates only; a push never carries rows.
        var rows: [LockRow]? = nil

        var settled: Bool { phase == "settled" }
        var computedAt: Date { Date(timeIntervalSince1970: TimeInterval(at)) }
    }
}

/// What the app last knew of one machine, for its Live Activity: the machine's name, its most
/// urgent rows and the approval it may answer, all as of the content `seq` they go with.
struct MachineLockEntry: Codable, Hashable, Sendable {
    let slot: Int
    let name: String
    let seq: Int
    let rows: [LockRow]
    var request: LockRequest? = nil
}

/// The app-group file the machine activities read their names and rows from. Bounded, and
/// holding titles, status marks and one-line requests only, as `LockSnapshotStore` does.
enum MachineSnapshotStore {
    static let file = "lock-machines.json"
    static let maxBytes = 64 * 1024

    static func url() -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: LockSnapshotStore.group)?.appending(path: file)
    }
    static func read(slot: Int, from url: URL? = url()) -> MachineLockEntry? {
        guard let url, let data = try? Data(contentsOf: url), data.count <= maxBytes,
              let entries = try? decoder.decode([MachineLockEntry].self, from: data) else { return nil }
        return entries.first { $0.slot == slot }
    }
    static func write(_ entries: [MachineLockEntry], to url: URL? = url()) {
        guard let url, let data = try? encoder.encode(entries), data.count <= maxBytes else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    private static let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .millisecondsSince1970; return e }()
    private static let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .millisecondsSince1970; return d }()
}

/// What one machine's activity shows, from its content and the snapshot. Pure, so the rules are
/// tested without WidgetKit: counts always come from the content; the machine's name, rows and
/// Allow/Deny come from the snapshot only when its `seq` equals the content's, so a row never
/// shows a status older than the counts beside it.
struct MachineActivityLook {
    let state: MachineActivityAttributes.ContentState
    let stale: Bool
    /// The snapshot entry, kept only when it goes with this content.
    let matched: MachineLockEntry?

    init(state: MachineActivityAttributes.ContentState, snapshot: MachineLockEntry?, stale: Bool) {
        self.state = state
        self.stale = stale
        matched = snapshot?.seq == state.seq ? snapshot : nil
    }

    var name: String? { matched.flatMap { $0.name.isEmpty ? nil : $0.name } }
    /// A local update's own rows, else the matching snapshot's, at most three.
    var rows: [LockRow] { Array((state.rows ?? matched?.rows ?? []).prefix(3)) }
    /// Offered only on fresh content whose snapshot matches.
    var request: LockRequest? { stale ? nil : matched?.request }

    /// The counts as a `LockSummary`, for the shared lock-screen views (glyph, count, rows).
    var summary: LockSummary {
        LockSummary(needsYou: state.needsYou, working: state.working, failed: state.failed, waiting: state.waiting,
                    limited: state.limited, background: state.background, rows: rows, request: request,
                    current: !stale && matched != nil, live: true, busy: !state.settled, updatedAt: state.computedAt)
    }
    /// "1 needs you · 2 working"; once settled, what finished ("3 done · 1 failed").
    var headline: String {
        if state.settled {
            let parts = [(state.done, "done"), (state.failed, "failed")].filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }
            return parts.isEmpty ? "Nothing needs you" : parts.joined(separator: " · ")
        }
        return summary.headline
    }
    /// After the headline: "as of 7:26 AM" past the stale date, a nudge to open ace when the
    /// snapshot doesn't go with these counts, else the machine's name.
    var note: String {
        if stale { return "as of \(state.computedAt.formatted(date: .omitted, time: .shortened))" }
        if rows.isEmpty, matched == nil { return "Open ace for details" }
        return name ?? "ace"
    }
    var spoken: String { "\(headline), \(note)" }
}
