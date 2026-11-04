/// The needs-you run's pages: every request waiting on the person across machines, one page
/// each, in the inbox's order. Pages already shown keep their places; requests that arrive
/// during the run join at the end. Moving on passes requests that closed meanwhile. The end
/// never says nothing waits while a request is still open or an answer is still on its way.
struct NeedsRunQueue: Equatable {
    struct Entry: Hashable, Sendable {
        let thread: InboxKey
        let request: String
    }
    /// How the run ends: nothing waits, answers are still travelling, or some were skipped
    /// (or refused) and still wait.
    enum End: Equatable {
        case nothing
        case sending(Int)
        case remaining(Int)
    }

    private(set) var pages: [Entry] = []
    /// The page on screen; `pages.count` is the end.
    private(set) var index = 0

    init(_ live: [Entry] = []) { pages = live }

    var atEnd: Bool { index >= pages.count }
    var current: Entry? { atEnd ? nil : pages[index] }
    /// Pages done, for the progress track: 0 to 1.
    var progress: Double { pages.isEmpty ? 1 : Double(min(index, pages.count)) / Double(pages.count) }

    /// Requests now waiting, in the inbox's order: new ones join at the end.
    mutating func merge(_ live: [Entry]) {
        let held = Set(pages)
        pages += live.filter { !held.contains($0) }
    }
    /// The next page whose request still waits for an answer; past the last, the end.
    mutating func next(open: (Entry) -> Bool) {
        var at = index + 1
        while at < pages.count, !open(pages[at]) { at += 1 }
        index = min(at, pages.count)
    }
    /// The page before, whatever became of it.
    mutating func back() { index = max(0, index - 1) }
    /// The current page closed while on screen (answered elsewhere): move past it.
    mutating func skipClosed(open: (Entry) -> Bool) {
        guard let current, !open(current) else { return }
        index -= 1
        next(open: open)
    }
    /// Go through what still waits again, from the start.
    mutating func again(_ live: [Entry]) {
        pages = live
        index = 0
    }

    /// `waiting`: requests still open with no answer on its way; `sending`: answered here, not
    /// yet closed by their machine.
    static func end(waiting: Int, sending: Int) -> End {
        waiting > 0 ? .remaining(waiting) : sending > 0 ? .sending(sending) : .nothing
    }
}
