import Foundation

/// Builds the lock screen's `LockSummary` from every paired machine's inbox rows. Pure: it only
/// counts and orders what the bridge already decided for each row (`RowLook.state`, its mark and
/// meaning, from the daemon's whole-tree status); it never derives whether a thread is done or
/// working. Machines run separate runtimes, so combining them happens here.
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
        var offline = 0, unconfirmed = 0
        var counts: [String: Int] = [:]
        var ranked: [(rank: Int, order: Double, row: LockRow)] = []
        for machine in machines {
            // An unreachable machine's rows are only the last known: none of them is counted.
            guard machine.online else { offline += 1; current = false; continue }
            for row in machine.rows where row.archivedAt == nil {
                // A copy the machine hasn't confirmed claims nothing, and keeps the summary open.
                guard let look = row.look, row.confirmed == true, look.level != "syncing" else {
                    unconfirmed += 1; current = false; continue
                }
                let state = state(look)
                guard let rank = rank(state) else { continue }
                counts[state, default: 0] += 1
                ranked.append((rank, order(row, look, state), lockRow(row, look, state: state, hostId: machine.hostId)))
            }
        }
        ranked.sort { $0.rank != $1.rank ? $0.rank < $1.rank : $0.order < $1.order }
        let rows = Array(ranked.prefix(rowLimit).map(\.row))
        let request = rows.lazy.filter(\.needsYou).compactMap { requests[key(host: $0.hostId, thread: $0.id)] }.first
        let live = machines.count > offline
        let summary = LockSummary(
            needsYou: counts["needs-you"] ?? 0, working: counts["working"] ?? 0, failed: counts["failed"] ?? 0,
            waiting: counts["waiting"] ?? 0, limited: counts["limited"] ?? 0, background: counts["background"] ?? 0,
            rows: rows, request: request, current: current, live: live, offline: offline, busy: false, updatedAt: now)
        var result = summary
        // Live work, a wait or a request keeps it up; so does a copy still syncing, or no machine
        // answering at all. A machine that is off while the others answer doesn't, on its own.
        result.busy = summary.needsYou + summary.working + summary.waiting + summary.limited + summary.background > 0
            || unconfirmed > 0 || !live
        return result
    }

    static func key(host: String, thread: String) -> String { "\(host)\u{0}\(thread)" }

    /// The row's state from the bridge (`rowStatusState`). A bridge without it is read by level
    /// alone, and live work there counts as a wait: never as working on a guess.
    static func state(_ look: RowLook) -> String {
        if let state = look.state { return state }
        switch look.level {
        case "needs-you": return "needs-you"
        case "failed": return "failed"
        case "done-unread": return "finished"
        case "active": return "waiting"
        default: return "idle"
        }
    }
    /// What shows, in the status table's order; quiet and seen rows don't.
    private static func rank(_ state: String) -> Int? {
        switch state {
        case "needs-you": 0
        case "failed": 1
        case "working": 2
        case "waiting": 3
        case "limited": 4
        case "background": 5
        case "finished": 6
        default: nil
        }
    }
    /// Live work and background commands show the system's running time; waits and limits don't.
    private static func runs(_ state: String) -> Bool { state == "working" || state == "background" }
    /// Within a rank: the longest waiting or running first; results newest first.
    private static func order(_ row: ThreadRow, _ look: RowLook, _ state: String) -> Double {
        let at = look.since ?? row.activityAt ?? row.updatedAt
        return state == "failed" || state == "finished" ? -at : at
    }
    private static func lockRow(_ row: ThreadRow, _ look: RowLook, state: String, hostId: String) -> LockRow {
        let title = row.title.isEmpty ? "New thread" : String(row.title.prefix(titleLimit))
        let since = runs(state) && look.mode == "elapsed" ? look.since.map { Date(timeIntervalSince1970: $0 / 1000) } : nil
        return LockRow(id: row.id, hostId: hostId, title: title, icon: look.icon ?? "none", tone: look.iconTone ?? "idle",
                       count: look.count, meaning: look.meaning ?? look.word ?? "", since: since,
                       link: AceLink.thread(row.id, machine: hostId).absoluteString, needsYou: state == "needs-you")
    }
}
