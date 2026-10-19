import Foundation

/// Which alerts this device already showed, and how far its catch-up has read. Pure and Codable.
/// The same alert arrives live and again from catch-up; the ledger admits it once.
struct NotificationLedger: Codable, Equatable, Sendable {
    static let capacity = 512
    private(set) var cursor = 0
    private(set) var shown: [String] = []

    /// True the first time an id is seen. Bounded: the oldest ids age out.
    mutating func admit(_ id: String) -> Bool {
        guard !shown.contains(id) else { return false }
        shown.append(id)
        if shown.count > Self.capacity { shown.removeFirst(shown.count - Self.capacity) }
        return true
    }
    /// The daemon's head may move backwards when its database is rebuilt; follow it.
    mutating func advance(to cursor: Int) { self.cursor = max(0, cursor) }
}

/// Persists one ledger per paired daemon and device.
struct LedgerStore: Sendable {
    let key: String
    nonisolated(unsafe) let defaults: UserDefaults
    init(scope: String, defaults: UserDefaults = .standard) { key = "ace.notifications.ledger.\(scope)"; self.defaults = defaults }
    func load() -> NotificationLedger {
        guard let data = defaults.data(forKey: key), let ledger = try? JSONDecoder().decode(NotificationLedger.self, from: data) else { return NotificationLedger() }
        return ledger
    }
    func save(_ ledger: NotificationLedger) {
        if let data = try? JSONEncoder().encode(ledger) { defaults.set(data, forKey: key) }
    }
}
