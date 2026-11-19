import Foundation

/// Where the reader was in one thread, above any single transcript view's
/// lifetime: surviving navigation away and compact/regular layout replacement.
/// In-memory only (like the web scroll memory): relaunch starts at the live
/// end. Bounded per machine/thread with LRU eviction.
struct TranscriptReadingSession: Equatable, Sendable {
    var threadID: String
    var machineID: String?
    var mode: TranscriptMode
    /// Semantic anchor: the held row, an item it shows, and its pixel offset
    /// from the viewport top when last seen.
    var anchor: TranscriptHeldAnchor?
    /// The last row when left; a matching end means nothing new arrived since.
    var lastKey: String?
    var paged: Bool
    var updatedAt: Double

    var isLive: Bool { mode == .following || anchor == nil }

    static func live(threadID: String, machineID: String?, now: Double) -> Self {
        Self(threadID: threadID, machineID: machineID, mode: .following,
             anchor: nil, lastKey: nil, paged: false, updatedAt: now)
    }
}

/// Bounded store of reading sessions, keyed by machine then thread. The feed
/// saves on disappear and restores on appear; the shelf keeps threads, this
/// keeps where the reader was in each of them.
struct TranscriptSessionStore: Equatable, Sendable {
    static let capacity = 32
    private var entries: [String: TranscriptReadingSession] = [:]
    /// Least recently saved first.
    private var order: [String] = []

    static func key(threadID: String, machineID: String?) -> String {
        "\(machineID ?? "-")/\(threadID)"
    }

    mutating func save(_ session: TranscriptReadingSession) {
        let key = Self.key(threadID: session.threadID, machineID: session.machineID)
        if session.isLive {
            // At the live end there is nothing to restore: forget it.
            entries.removeValue(forKey: key)
            order.removeAll { $0 == key }
            return
        }
        entries[key] = session
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > Self.capacity {
            let oldest = order.removeFirst()
            entries.removeValue(forKey: oldest)
        }
    }

    func recall(threadID: String, machineID: String?) -> TranscriptReadingSession? {
        entries[Self.key(threadID: threadID, machineID: machineID)]
    }

    /// Restore a non-live session however the tail moved since: new arrivals
    /// never discard the reader's position, and the saved anchor row need not
    /// be in the current live tail — the feed rebuilds the history window
    /// around the saved item identity. Live-end sessions restore as nothing.
    func restorable(threadID: String, machineID: String?) -> TranscriptReadingSession? {
        guard let saved = recall(threadID: threadID, machineID: machineID), !saved.isLive else { return nil }
        return saved
    }

    mutating func remove(threadID: String, machineID: String?) {
        let key = Self.key(threadID: threadID, machineID: machineID)
        entries.removeValue(forKey: key)
        order.removeAll { $0 == key }
    }

    mutating func clear() {
        entries.removeAll()
        order.removeAll()
    }

    var count: Int { entries.count }
}
