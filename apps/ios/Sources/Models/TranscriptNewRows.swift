/// How many transcript rows landed after the newest one the reader saw at the live end, for the
/// count on Scroll to end.
///
/// The rule reads only the live window's row order (oldest first): rows past the newest row seen
/// at the end are new. A row that streams keeps its place in the order, so its updates never
/// count. Reaching the end takes the newest row as seen and clears the count.
struct TranscriptNewRows: Equatable, Sendable {
    /// The newest row the reader saw at the end; nil before any order was seen.
    private(set) var seenNewest: String?
    /// New rows the reader hasn't reached.
    private(set) var count = 0
    /// Rows counted before `seenNewest` last had to move on.
    private var carried = 0

    /// The badge's words: nil at zero, "99+" past 99.
    var badge: String? { Self.badge(count) }
    static func badge(_ count: Int) -> String? {
        count <= 0 ? nil : count > 99 ? "99+" : String(count)
    }

    /// The live order changed. At the end, everything in it is seen.
    mutating func update(order: [String], atEnd: Bool) {
        guard !atEnd, let seenNewest else {
            reachedEnd(order: order)
            return
        }
        // Searched from the newest end: work grows with the rows that landed, not with history.
        guard let index = order.lastIndex(of: seenNewest) else {
            // The seen row left the window (deleted, or the window was replaced): the rows
            // already counted stay counted, and the newest one now marks the place.
            carried = count
            self.seenNewest = order.last ?? seenNewest
            return
        }
        count = carried + order.count - 1 - index
    }

    /// The reader reached the end: what's there now is seen.
    mutating func reachedEnd(order: [String]) {
        seenNewest = order.last
        count = 0
        carried = 0
    }
}
