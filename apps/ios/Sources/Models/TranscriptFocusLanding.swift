import Foundation

/// Bringing a focused message (a search hit, a focused open, a turn from the turn list) into
/// view. Pure: the row that shows the item and its measured frame in, one step out.
///
/// The focus holds the reader's place until its row has been shown once. A window's rows can
/// land before the reply that names the focus, and a lazy row scrolled to before it is drawn
/// lands at an estimate, so one scroll is not enough: the feed scrolls again each time the row
/// lands or measures, and pages and the end's hold or follow wait meanwhile, until the row sits
/// in the middle half of the screen. Only then does the ordinary held place take over. The
/// reader scrolling ends it, and so does a row that never settles within the budget.
struct TranscriptFocusLanding: Equatable, Sendable {
    /// The item to bring into view, until its row has been shown.
    private(set) var target: String?
    private(set) var scrolls = 0
    /// A jump's reply is still to name the item it brought into view.
    private(set) var awaitsReply = false
    /// Scrolls spent on one focus before it stops being chased.
    static let maxScrolls = 30

    /// The part of the feed the reader sees, in the feed's coordinates: under the header and
    /// above the composer.
    struct Band: Equatable, Sendable {
        var top: Double
        var bottom: Double
    }

    /// A row's measured top and bottom, in the same coordinates as the band.
    struct Span: Equatable, Sendable {
        var top: Double
        var bottom: Double
    }

    enum Step: Equatable, Sendable {
        /// No focus is landing: the ordinary place-keeping applies.
        case none
        /// The focus's row isn't among the rows yet: hold the place, scroll nowhere.
        case wait
        /// Scroll the row to the middle of the screen.
        case scroll(rowID: String)
        /// The row is in view: hold it where it is from here.
        case landed(rowID: String)
    }

    /// Whether a focus still owns the reader's place: no page, no end read, no other restore.
    var holdsPlace: Bool { target != nil }
    /// A focus is landing or a jump's reply is still to name one.
    var isActive: Bool { holdsPlace || awaitsReply }

    /// A jump was sent: aim at the item asked for (nil for a turn, whose item only the reply
    /// names) before the reply, since the window's rows can land first.
    mutating func jumped(to item: String?) {
        aim(at: item)
        awaitsReply = true
    }

    /// The jump's reply names the item the bridge brought into view, or none. A reply to any
    /// other read (a page, a reopened session, a rebuild) changes nothing.
    mutating func replied(focus: String?) {
        guard awaitsReply else { return }
        awaitsReply = false
        aim(at: focus)
    }

    /// The reader moved the feed: their place, not the focus's.
    mutating func readerTookOver() {
        aim(at: nil)
        awaitsReply = false
    }

    /// A new focus starts a fresh budget.
    private mutating func aim(at item: String?) {
        target = item
        scrolls = 0
    }

    /// The next step for the focus, given the row now showing its item (nil until that row
    /// lands) and the row's frame (nil until it's drawn).
    mutating func step(row: String?, frame: Span?, band: Band) -> Step {
        guard target != nil else { return .none }
        guard let row else { return .wait }
        if let frame, Self.shows(frame, in: band) {
            aim(at: nil)
            return .landed(rowID: row)
        }
        guard scrolls < Self.maxScrolls else {
            aim(at: nil)
            return .none
        }
        scrolls += 1
        return .scroll(rowID: row)
    }

    /// The row's middle is in the middle half of the band, where a centred scroll puts it.
    private static func shows(_ frame: Span, in band: Band) -> Bool {
        let height = band.bottom - band.top
        guard height > 0 else { return false }
        let middle = (frame.top + frame.bottom) / 2
        let centre = (band.top + band.bottom) / 2
        return abs(middle - centre) <= height / 4
    }
}
