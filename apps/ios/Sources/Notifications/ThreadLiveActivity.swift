import ActivityKit
import Foundation

/// Serializes deferred Live Activity commits without ActivityKit: each update notes its
/// revision synchronously; a queued task only delivers if still latest after awaiting its
/// predecessor. A disconnect or Working notes a newer revision, revoking a pending end.
struct LiveActivityCommitGate {
    private var latest: [String: Int] = [:]
    private var counter = 0
    mutating func note(id: String) -> Int {
        counter += 1
        latest[id] = counter
        return counter
    }
    func shouldCommit(id: String, revision: Int) -> Bool {
        latest[id] == revision
    }
    mutating func remove(id: String) {
        latest.removeValue(forKey: id)
    }
}

/// A local ActivityKit shell driven only by the daemon's canonical whole-tree inbox row.
/// Offline and stale states explicitly ask the person to reopen ace. APNs updates are separate.
///
/// Content dedup keeps patch storms cheap, but an unchanged row still re-issues its content
/// every `renewalInterval` so `staleDate` never lapses while the canonical status holds.
/// Only a freshly confirmed canonical done row while online ends its activity; unconfirmed
/// content says Syncing and never claims Done.
@MainActor final class ThreadLiveActivity {
    /// How often an unchanged row renews its `staleDate` (well under `staleAfter`).
    static let refreshEvery: TimeInterval = 30
    /// How long iOS shows content without an update before marking it stale.
    static let staleAfter: TimeInterval = 60
    /// How long a finished thread stays on the Lock Screen after its canonical done row.
    static let dismissalAfter: TimeInterval = 300

    private let now: () -> Date
    private let renewalInterval: TimeInterval
    private var last: [String: (key: String, refreshedAt: Date)] = [:]
    private var gate = LiveActivityCommitGate()
    private var queue: Task<Void, Never>?

    init(now: @escaping () -> Date, renewalInterval: TimeInterval = ThreadLiveActivity.refreshEvery) {
        self.now = now
        self.renewalInterval = renewalInterval
    }
    func start(row: ThreadRow, hostId: String, online: Bool) throws {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { throw ServiceFailure(message: "Live Activities are disabled in iOS Settings.") }
        if Activity<ThreadActivityAttributes>.activities.contains(where: { $0.attributes.hostId == hostId && $0.attributes.threadId == row.id && ($0.activityState == .active || $0.activityState == .stale) }) { return }
        let at = now()
        let activity = try Activity.request(attributes: ThreadActivityAttributes(hostId: hostId, threadId: row.id), content: content(row, online: online, at: at), pushType: nil)
        last[activity.id] = (Self.key(row: row, online: online), at)
    }
    /// `row` reads one thread's row, so an inbox change costs nothing while no activity runs.
    func update(row: (String) -> ThreadRow?, hostId: String, online: Bool) {
        prune()
        for activity in Activity<ThreadActivityAttributes>.activities where activity.attributes.hostId == hostId && (activity.activityState == .active || activity.activityState == .stale) {
            // The thread left the inbox (deleted, archived, reset): revoke any queued end.
            // Rows stay normalized by ClientModel, the single generation authority.
            guard let row = row(activity.attributes.threadId) else {
                _ = gate.note(id: activity.id)
                last.removeValue(forKey: activity.id)
                continue
            }
            let key = Self.key(row: row, online: online)
            let at = now()
            guard Self.shouldRefresh(last: last[activity.id], key: key, now: at, renewalInterval: renewalInterval) else { continue }
            last[activity.id] = (key, at)
            let revision = gate.note(id: activity.id)
            // Capture values before the serialized hop so the queued task never retains this shell.
            let next = content(row, online: online, at: at)
            let previous = queue
            let ending = Self.shouldEnd(state: row.state, online: online, confirmed: row.confirmed)
            let endDate = at.addingTimeInterval(Self.dismissalAfter)
            let activityId = activity.id
            // ActivityKit's handle isn't Sendable, but its update and end are safe from any
            // context; the gate above still orders every commit on the main actor.
            nonisolated(unsafe) let target = activity
            queue = Task { @MainActor [weak self] in
                await previous?.value
                guard self?.gate.shouldCommit(id: activityId, revision: revision) == true else { return }
                if ending { await target.end(next, dismissalPolicy: .after(endDate)) }
                else { await target.update(next) }
            }
        }
    }

    /// Pure freshness decision, free of ActivityKit so tests can pin the clock: a first
    /// sighting or changed canonical content refreshes at once, while an unchanged row
    /// still renews once the interval since its last refresh has passed.
    nonisolated static func shouldRefresh(last: (key: String, refreshedAt: Date)?, key: String, now: Date, renewalInterval: TimeInterval) -> Bool {
        guard let last else { return true }
        guard last.key == key else { return true }
        return now.timeIntervalSince(last.refreshedAt) >= renewalInterval
    }

    /// Only a freshly confirmed canonical done row while online finishes the activity. A cached
    /// done row across a reconnect, or an offline one, keeps truthful content until the daemon's
    /// snapshot confirms it. Missing confirmations (old payloads) never end.
    nonisolated static func shouldEnd(state: String, online: Bool, confirmed: Bool?) -> Bool {
        state == "done" && online && confirmed == true
    }

    /// Older generations (and missing ones) read as unconfirmed: ClientModel, the single
    /// generation authority, normalizes its rows before updates and ticks, so a ready
    /// connection before its row frames never finishes on a cached confirmation.
    nonisolated static func effectiveRow(_ row: ThreadRow, latestGeneration: Int) -> ThreadRow {
        if row.generation == latestGeneration { return row }
        var stale = row
        stale.confirmed = nil
        return stale
    }

    nonisolated static func key(row: ThreadRow, online: Bool) -> String {
        [row.title, displayLabel(row: row, online: online), displayToken(row: row, online: online), String(online), String(row.confirmed == true)].joined(separator: "\u{0}")
    }

    /// Drops tracking for finished or withdrawn activities so `last` stays bounded by the
    /// live set; the next `update` relearns anything still around.
    private func prune() {
        let live = Set(Activity<ThreadActivityAttributes>.activities.compactMap {
            $0.activityState == .active || $0.activityState == .stale ? $0.id : nil
        })
        for id in last.keys where !live.contains(id) {
            last.removeValue(forKey: id)
            gate.remove(id: id)
        }
    }
    private func content(_ row: ThreadRow, online: Bool, at: Date) -> ActivityContent<ThreadActivityAttributes.ContentState> {
        ActivityContent(state: .init(title: row.title, label: Self.displayLabel(row: row, online: online), token: Self.displayToken(row: row, online: online), online: online, confirmed: row.confirmed, updatedAt: at), staleDate: at.addingTimeInterval(Self.staleAfter))
    }
    /// What the activity shows: the daemon's word once confirmed, Syncing while a connected row
    /// is still a cached copy, and the canonical word offline (the widget says Offline there).
    nonisolated static func displayLabel(row: ThreadRow, online: Bool) -> String {
        if online && row.confirmed != true { return "Syncing" }
        return row.status.label
    }
    nonisolated static func displayToken(row: ThreadRow, online: Bool) -> String {
        if online && row.confirmed != true { return "neutral" }
        return row.status.token
    }
}
