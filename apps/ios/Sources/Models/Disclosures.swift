import Observation

/// The folds a person opened in one thread's transcript ("Worked for" heads, subagent rollups),
/// by block key. A thread reopened on the way back from a child, and a page of its history, share
/// the same set, so what was open stays open.
@MainActor @Observable final class Disclosures {
    private var open: Set<String> = []
    /// Counts the folds the person opened, so the feed can keep what they opened in place.
    private(set) var opens = 0
    func isOpen(_ key: String) -> Bool { open.contains(key) }
    func toggle(_ key: String) {
        if open.contains(key) { open.remove(key) } else { open.insert(key); opens += 1 }
        closed.remove(key)
    }
    /// Folds the person closed on purpose, apart from ones never touched: a work log's group
    /// opens by itself while it holds a step they opened, until they close the group.
    private var closed: Set<String> = []
    /// Whether the person opened (true) or closed (false) a fold; nil when they never touched it.
    func chosen(_ key: String) -> Bool? {
        open.contains(key) ? true : closed.contains(key) ? false : nil
    }
    func set(_ key: String, open value: Bool) {
        if value { if open.insert(key).inserted { opens += 1 }; closed.remove(key) } else { open.remove(key); closed.insert(key) }
    }
}
