import Foundation

/// Rows that scrolled off the top of the main screen, oldest first, in a fixed-size ring so a
/// long-running build never grows memory or copies the history on each new line.
struct TerminalScrollback: Sendable {
    let limit: Int
    private var storage: [TerminalLine] = []
    private var head = 0

    init(limit: Int) { self.limit = max(0, limit) }

    var count: Int { storage.count }

    subscript(index: Int) -> TerminalLine {
        storage[(head + index) % storage.count]
    }

    mutating func append(_ line: TerminalLine) {
        guard limit > 0 else { return }
        if storage.count < limit { storage.append(line) }
        else {
            storage[head] = line
            head = (head + 1) % limit
        }
    }

    /// Take back the newest row (a taller screen pulls history down again).
    mutating func popLast() -> TerminalLine? {
        guard !storage.isEmpty else { return nil }
        if storage.count < limit || head == 0 { return storage.removeLast() }
        // A full ring: the newest sits just before head. Unroll once, then pop.
        storage = Array(storage[head...] + storage[..<head])
        head = 0
        return storage.removeLast()
    }

    mutating func removeAll() {
        storage = []
        head = 0
    }

    /// Rows `range` in order, for drawing what is on screen.
    func slice(_ range: Range<Int>) -> [TerminalLine] {
        range.map { self[$0] }
    }
}
