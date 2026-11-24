import ActivityKit
import Foundation

/// The opaque slot is the only machine identifier that leaves the phone in an ActivityKit push.
struct MachineActivityAttributes: ActivityAttributes {
    var slot: Int
    var version = 1

    struct ContentState: Codable, Hashable, Sendable {
        var seq: Int
        var at: Int
        var phase: String
        var needsYou: Int
        var working: Int
        var failed: Int
        var waiting: Int
        var limited: Int
        var background: Int
        var done: Int
        var rows: [LockRow]?

        init(_ summary: LockSummary, seq: Int, settled: Bool = false) {
            self.seq = seq
            at = Int(summary.updatedAt.timeIntervalSince1970)
            phase = settled ? "settled" : "busy"
            needsYou = summary.needsYou
            working = summary.working
            failed = summary.failed
            waiting = summary.waiting
            limited = summary.limited
            background = summary.background
            done = settled ? summary.rows.filter { $0.icon == "done" }.count : 0
        }

        func acceptsLocalUpdate(_ next: Self) -> Bool { next.seq >= seq }

        var summary: LockSummary {
            let settled = phase == "settled"
            return LockSummary(needsYou: needsYou, working: working, failed: failed, waiting: waiting,
                               limited: limited, background: background, rows: [], current: settled, live: true,
                               busy: !settled, updatedAt: Date(timeIntervalSince1970: TimeInterval(at)),
                               completed: settled ? done : nil)
        }
    }
}

struct MachineActivitySnapshot: Codable, Hashable, Sendable {
    let seq: Int
    let name: String
    let rows: [LockRow]
    let request: LockRequest?

    static func url(slot: Int) -> URL? {
        guard (0..<16).contains(slot) else { return nil }
        return LockSnapshotStore.url()?.deletingLastPathComponent().appending(path: "machine-activity-\(slot).json")
    }

    static func read(slot: Int) -> Self? {
        guard let url = url(slot: slot), let data = try? Data(contentsOf: url),
              data.count <= LockSnapshotStore.maxBytes else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }

    static func write(_ snapshot: Self?, slot: Int) {
        guard let url = url(slot: slot) else { return }
        guard let snapshot else {
            try? FileManager.default.removeItem(at: url)
            return
        }
        guard let data = try? JSONEncoder().encode(snapshot), data.count <= LockSnapshotStore.maxBytes else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

struct MachineActivityPresentation {
    var summary: LockSummary
    let name: String?
    let detailHint: String?

    init(state: MachineActivityAttributes.ContentState, snapshot: MachineActivitySnapshot?) {
        summary = state.summary
        if let snapshot, snapshot.seq == state.seq {
            name = snapshot.name
            detailHint = nil
            summary.rows = Array(snapshot.rows.prefix(3))
            summary.request = state.needsYou > 0 ? snapshot.request : nil
        } else {
            name = nil
            detailHint = "Open ace for details"
        }
    }
}
