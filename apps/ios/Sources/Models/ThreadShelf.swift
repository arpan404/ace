import Foundation

/// The threads this phone showed most recently, kept whole after the person leaves them, as the
/// web keeps its thread stores warm. Reopening one shows it at once and tells the bridge so; the
/// bridge then sends only what changed since (`bridge/native-ledger.ts`, which keeps as many).
/// Kept threads take no updates here while they are not open; the bridge keeps the ones left in
/// the last five minutes followed (ADR 0146), so reopening one sends what changed at once.
///
/// Reading sessions (where the reader was in each thread) are kept alongside,
/// bounded independently like the web scroll memory: a thread evicted from the
/// shelf keeps its session until the session bound pushes it out, and clearing
/// the cache clears sessions too.
@MainActor struct ThreadShelf {
    static let capacity = 6
    /// Least recently shown first.
    private(set) var threads: [ThreadModel] = []

    /// Keep a thread the person is leaving. One that never finished loading isn't worth showing.
    mutating func keep(_ thread: ThreadModel) {
        thread.refresh = nil
        threads.removeAll { $0.id == thread.id }
        guard thread.loaded else { return }
        threads.append(thread)
        if threads.count > Self.capacity { threads.removeFirst(threads.count - Self.capacity) }
    }
    /// The kept copy of `id`, taken off the shelf to be shown again.
    mutating func take(_ id: String) -> ThreadModel? {
        guard let index = threads.firstIndex(where: { $0.id == id }) else { return nil }
        return threads.remove(at: index)
    }
    mutating func clear() { threads.removeAll() }
    /// A new runtime for the same machine holds none of these copies: each reopens cold, its kept
    /// rows staying on screen until the full read replaces them.
    func needSnapshots() { for thread in threads { thread.requiresSnapshot = true } }
}
