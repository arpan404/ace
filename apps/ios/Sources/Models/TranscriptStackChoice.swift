/// Which stack holds the transcript's rows (ADR 0157).
///
/// A lazy stack estimates the heights of the rows it hasn't laid out. With a few dozen rows of very
/// different heights, those estimates could swap by a point on every pass, which kept the scroll
/// view decelerating and the main thread laying out for good (#2051). A plain stack lays every row
/// out and never estimates, so a short window is held in one; past `limit` rows the lazy stack
/// keeps the cost of a long window bounded. A switch rebuilds every row, so it happens rarely and
/// only while the feed is still: an eager stack turns lazy once its rows pass the limit, and a lazy
/// one turns eager only when its window is replaced (a jump, Scroll to end, a reconnect) by one at
/// or under three quarters of the limit. Pure.
struct TranscriptStackChoice: Equatable, Sendable {
    enum Stack: Equatable, Sendable { case eager, lazy }

    /// Rows a plain stack holds before the feed turns lazy: twice the window that stalled
    /// (`ios-log-long`, about 24 rows) and well under the 201 whose eager open broke the
    /// performance gate (ADR 0157).
    static let defaultLimit = 48

    let limit: Int
    /// The stack the feed uses; nil until its first rows.
    private(set) var stack: Stack?
    /// The window was replaced since the feed was last still.
    private var replaced = false

    init(limit: Int = Self.defaultLimit) { self.limit = limit }

    /// Rows a lazy stack's replacement window must be at or under to turn eager again.
    var lowMark: Int { limit * 3 / 4 }

    /// The stack for the feed's first rows; later calls return the stack already chosen.
    mutating func opened(rows: Int) -> Stack {
        if let stack { return stack }
        let chosen: Stack = rows > limit ? .lazy : .eager
        stack = chosen
        return chosen
    }

    /// The rows changed, the window was replaced, or the feed came to rest. Returns the stack to
    /// switch to, or nil. While `moving` (a gesture, an animated scroll) nothing switches; a
    /// replacement is remembered for the next still moment.
    mutating func update(rows: Int, moving: Bool, replaced wasReplaced: Bool = false) -> Stack? {
        guard let current = stack else { return nil }
        if wasReplaced { replaced = true }
        guard !moving else { return nil }
        defer { replaced = false }
        switch current {
        case .eager where rows > limit:
            stack = .lazy
        case .lazy where replaced && rows <= lowMark:
            stack = .eager
        default:
            return nil
        }
        return stack
    }
}
