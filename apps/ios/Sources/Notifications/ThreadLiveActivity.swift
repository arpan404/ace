import ActivityKit
import Foundation

/// A local ActivityKit shell driven only by the daemon's canonical whole-tree inbox row.
/// Offline and stale states explicitly ask the person to reopen ace. APNs updates are separate.
///
/// Content dedup keeps patch storms cheap, but an unchanged row still re-issues its content
/// every `renewalInterval` so `staleDate` never lapses while the canonical status holds.
/// Only a canonical done row while online ends its activity; everything else stays truthful.
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
    func update(rows: [String: ThreadRow], hostId: String, online: Bool) {
        prune()
        for activity in Activity<ThreadActivityAttributes>.activities where activity.attributes.hostId == hostId && (activity.activityState == .active || activity.activityState == .stale) {
            guard let row = rows[activity.attributes.threadId] else { continue }
            let key = Self.key(row: row, online: online)
            let at = now()
            guard Self.shouldRefresh(last: last[activity.id], key: key, now: at, renewalInterval: renewalInterval) else { continue }
            last[activity.id] = (key, at)
            // Capture values before the serialized hop so the queued task never retains this shell.
            let next = content(row, online: online, at: at)
            let previous = queue
            let ending = Self.shouldEnd(state: row.state, online: online)
            let endDate = at.addingTimeInterval(Self.dismissalAfter)
            queue = Task {
                await previous?.value
                if ending { await activity.end(next, dismissalPolicy: .after(endDate)) }
                else { await activity.update(next) }
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

    /// Only a canonical done row while online finishes the activity. An offline done row
    /// keeps its last truthful content until the daemon confirms it on reconnect.
    nonisolated static func shouldEnd(state: String, online: Bool) -> Bool { state == "done" && online }

    nonisolated static func key(row: ThreadRow, online: Bool) -> String {
        [row.title, row.status.label, row.status.token, String(online)].joined(separator: "\u{0}")
    }

    /// Drops tracking for finished or withdrawn activities so `last` stays bounded by the
    /// live set; the next `update` relearns anything still around.
    private func prune() {
        let live = Set(Activity<ThreadActivityAttributes>.activities.compactMap {
            $0.activityState == .active || $0.activityState == .stale ? $0.id : nil
        })
        for id in last.keys where !live.contains(id) { last.removeValue(forKey: id) }
    }
    private func content(_ row: ThreadRow, online: Bool, at: Date) -> ActivityContent<ThreadActivityAttributes.ContentState> {
        ActivityContent(state: .init(title: row.title, label: row.status.label, token: row.status.token, online: online, updatedAt: at), staleDate: at.addingTimeInterval(Self.staleAfter))
    }
}
