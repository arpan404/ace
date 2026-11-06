import Foundation

/// The ace notifications on this phone, across every machine, and how a new one lands. Pure and
/// Codable, so the rules are tested directly:
/// - One notification per thread: each thread posts under one identifier, so a newer alert
///   replaces the older instead of stacking beside it.
/// - Finishes in a burst become one: a thread finishing within `burstWindow` of another turns
///   the finishes into a single "3 threads finished" summary, delivered quietly (the first one
///   already sounded), and the single ones are withdrawn.
/// - Withdrawals by alert (the daemon retracted it) or by thread (opened, or no longer asking).
struct AlertStack: Codable, Equatable, Sendable {
    struct Shown: Codable, Equatable, Sendable {
        /// `thread(_:hostId:)`, also the notification's identifier.
        let key: String
        let hostId: String?
        let threadId: String
        let alertId: String
        let status: String
        let title: String
        /// When it was posted (ms).
        let at: Double
        /// Folded into the finished summary; its own notification is gone.
        var folded = false
    }
    /// What to do on the notification center for one landing.
    struct Landing: Equatable, Sendable {
        var post: AlertContent?
        var withdraw: [String] = []
    }

    /// How close together finishes have to be to fold into one summary.
    static let burstWindow: Double = 2 * 60 * 1000
    /// The finished summary's identifier and group.
    static let summaryId = "ace|finished"
    /// Entries kept, oldest out first.
    static let capacity = 64
    static let storageKey = "ace.notifications.stack"

    private(set) var shown: [Shown] = []

    /// The one identifier a thread's notification posts under on this phone.
    static func thread(_ threadId: String, hostId: String?) -> String {
        "\(hostId ?? "")|thread|\(threadId)"
    }

    /// Lands `content` (built from `alert`) at `now`.
    mutating func land(_ content: AlertContent, alert: AlertNotification, now: Double) -> Landing {
        let key = Self.thread(alert.threadId, hostId: content.hostId)
        var landing = Landing()
        // The thread's older notification is replaced in place; drop its record.
        shown.removeAll { $0.key == key }
        var entry = Shown(key: key, hostId: content.hostId, threadId: alert.threadId, alertId: alert.id,
                          status: alert.status, title: content.threadTitle, at: now)
        if alert.status == "done" {
            let burst = shown.filter { $0.status == "done" && now - $0.at <= Self.burstWindow }
            if !burst.isEmpty {
                entry.folded = true
                landing.withdraw = burst.filter { !$0.folded }.map(\.key) + [key]
                for index in shown.indices where burst.contains(where: { $0.key == shown[index].key }) { shown[index].folded = true }
                let titles = (burst.map(\.title) + [entry.title]).reversed()
                landing.post = .finishedSummary(count: titles.count, titles: Array(titles))
                record(entry)
                return landing
            }
        }
        var posted = content
        posted.identifier = key
        landing.post = posted
        record(entry)
        return landing
    }

    /// The daemon no longer stands behind this alert: withdraw it if it is still the thread's.
    mutating func retract(_ alertId: String, hostId: String?) -> [String] {
        guard let index = shown.firstIndex(where: { $0.alertId == alertId && $0.hostId == hostId }) else { return [] }
        return remove(at: index)
    }
    /// The thread was opened, or its request answered or gone: its notification goes.
    mutating func clear(threadId: String, hostId: String?) -> [String] {
        guard let index = shown.firstIndex(where: { $0.threadId == threadId && $0.hostId == hostId }) else { return [] }
        return remove(at: index)
    }
    /// Every notification from one machine goes. A finish folded into the summary has none of
    /// its own; the summary stays.
    mutating func clear(hostId: String) -> [String] {
        let gone = shown.filter { $0.hostId == hostId }
        shown.removeAll { $0.hostId == hostId }
        return gone.filter { !$0.folded }.map(\.key)
    }
    /// Threads whose notification asks for the person, for checking against their rows.
    func asking(hostId: String) -> [String] {
        shown.filter { $0.hostId == hostId && $0.status == "needs_you" }.map(\.threadId)
    }

    private mutating func remove(at index: Int) -> [String] {
        let entry = shown.remove(at: index)
        // A folded finish has no notification of its own; the summary stays as it was.
        return entry.folded ? [] : [entry.key]
    }
    private mutating func record(_ entry: Shown) {
        shown.append(entry)
        if shown.count > Self.capacity { shown.removeFirst(shown.count - Self.capacity) }
    }

    static func load(_ defaults: UserDefaults) -> AlertStack {
        guard let data = defaults.data(forKey: storageKey), data.count <= 64 * 1024,
              let stack = try? JSONDecoder().decode(AlertStack.self, from: data) else { return AlertStack() }
        return stack
    }
    func save(_ defaults: UserDefaults) {
        if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.storageKey) }
    }
}
