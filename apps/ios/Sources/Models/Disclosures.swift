import Observation

/// The folds a person opened in one thread's transcript ("Worked for" heads, subagent rollups),
/// by block key. A thread reopened on the way back from a child, and a page of its history, share
/// the same set, so what was open stays open.
@MainActor @Observable final class Disclosures {
    private var open: Set<String> = []
    func isOpen(_ key: String) -> Bool { open.contains(key) }
    func toggle(_ key: String) {
        if open.contains(key) { open.remove(key) } else { open.insert(key) }
    }
}
