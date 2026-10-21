import Foundation

/// The threads a person left by opening a child (a delegated agent, a started conversation). Going
/// back reopens the parent under a new navigation generation; its last rendered transcript stays on
/// screen until that session's complete snapshot arrives, so the screen never flashes empty. Bounded:
/// only the nearest few parents are kept.
@MainActor struct ThreadTrail {
    static let depth = 4
    private(set) var parents: [ThreadModel] = []

    /// Opening `id` while `current` shows: a parent going back returns what it last showed, and
    /// a thread left for a child is remembered.
    mutating func reopen(_ id: String, leaving current: ThreadModel?) -> ThreadModel? {
        if let index = parents.lastIndex(where: { $0.id == id }) {
            let parent = parents[index]
            parents.removeSubrange(index...)
            parent.placeholder = nil
            return parent.order.isEmpty && parent.screen.blockOrder.isEmpty ? nil : parent
        }
        if let current, current.id != id {
            // A screen still showing its own placeholder remembers that instead.
            parents.append(current.placeholder ?? current)
            if parents.count > Self.depth { parents.removeFirst(parents.count - Self.depth) }
        }
        return nil
    }
    mutating func clear() { parents.removeAll() }
}
