import Foundation

/// Builds the lock screen's `LockSummary` from every paired machine's inbox rows. Pure: it only
/// counts and orders what the bridge already decided for each row (`RowLook.level`, its mark and
/// meaning, from the daemon's whole-tree status); it never derives whether a thread is done.
/// Machines run separate runtimes, so combining them happens here.
enum LockScreenBuilder {
    struct Machine {
        let hostId: String
        let rows: [ThreadRow]
        /// Connected and caught up; an offline machine's rows are only the last known.
        let online: Bool
    }

    /// Rows past this never reach any surface.
    static let rowLimit = LockSnapshotStore.maxRows
    /// A title is cut here; the lock screen shows one line anyway.
    static let titleLimit = 80

    /// `requests` holds each waiting approval the phone was told about, by `key(host:thread:)`;
    /// one shows only while its row still needs the person.
    static func summary(_ machines: [Machine], requests: [String: LockRequest], now: Date) -> LockSummary {
        var current = !machines.isEmpty
        var ranked: [(rank: Int, order: Double, row: LockRow)] = []
        var needsYou = 0, working = 0
        for machine in machines {
            if !machine.online { current = false }
            for row in machine.rows where row.archivedAt == nil {
                guard let look = row.look else { current = false; continue }
                // A copy the machine hasn't confirmed claims nothing, and keeps the summary open.
                if row.confirmed != true || look.level == "syncing" { current = false; continue }
                guard let rank = rank(look.level) else { continue }
                if look.level == "needs-you" { needsYou += 1 }
                if look.level == "active" { working += 1 }
                ranked.append((rank, order(row, look), lockRow(row, look, hostId: machine.hostId)))
            }
        }
        ranked.sort { $0.rank != $1.rank ? $0.rank < $1.rank : $0.order < $1.order }
        let rows = ranked.prefix(rowLimit).map(\.row)
        let request = rows.lazy.filter(\.needsYou).compactMap { requests[key(host: $0.hostId, thread: $0.id)] }.first
        return LockSummary(needsYou: needsYou, working: working, rows: Array(rows), request: request,
                           current: current, busy: needsYou + working > 0 || !current, updatedAt: now)
    }

    static func key(host: String, thread: String) -> String { "\(host)\u{0}\(thread)" }

    /// What shows, strongest first; quiet and seen rows don't.
    private static func rank(_ level: String) -> Int? {
        switch level {
        case "needs-you": 0
        case "active": 1
        case "failed": 2
        case "done-unread": 3
        default: nil
        }
    }
    /// Within a rank: the longest waiting or running first; results newest first.
    private static func order(_ row: ThreadRow, _ look: RowLook) -> Double {
        let at = look.since ?? row.activityAt ?? row.updatedAt
        return look.level == "failed" || look.level == "done-unread" ? -at : at
    }
    private static func lockRow(_ row: ThreadRow, _ look: RowLook, hostId: String) -> LockRow {
        let title = row.title.isEmpty ? "New thread" : String(row.title.prefix(titleLimit))
        let since = look.mode == "elapsed" ? look.since.map { Date(timeIntervalSince1970: $0 / 1000) } : nil
        return LockRow(id: row.id, hostId: hostId, title: title, icon: look.icon ?? "none", tone: look.iconTone ?? "idle",
                       count: look.count, meaning: look.meaning ?? look.word ?? "", since: since,
                       link: AceLink.thread(row.id, machine: hostId).absoluteString, needsYou: look.level == "needs-you")
    }
}
