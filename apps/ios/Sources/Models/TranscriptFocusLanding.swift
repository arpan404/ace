import Foundation

/// Bringing a focused message (a search hit, a focused open, a turn from the turn list) into
/// view. Pure: the row that shows the item, its measured frame, the feed's geometry and the
/// injected clock in, one step out.
///
/// The focus holds the reader's place until its row has been shown once. A window's rows can
/// land before the reply that names the focus, and a lazy row scrolled to before it is drawn
/// lands at an estimate, so one scroll is not enough: the feed places the row again each time
/// it lands or measures, and pages and the end's hold or follow wait meanwhile, until the row
/// sits in the middle half of what the reader sees. Only then does the ordinary held place take
/// over. The reader taking over ends it (a drag, a turn key, Scroll to end, VoiceOver), and so
/// do a failed read, a row that never settles within the scroll budget, and the deadline, which
/// the feed ticks when nothing else lays out.
struct TranscriptFocusLanding: Equatable, Sendable {
    /// The item to bring into view, until its row has been shown.
    private(set) var target: String?
    private(set) var scrolls = 0
    /// A jump's reply is still to name the item it brought into view.
    private(set) var awaitsReply = false
    /// When the focus lets the place go if it hasn't landed, in the clock's milliseconds.
    private(set) var deadline: Double?
    /// Scrolls spent on one focus before it stops being chased.
    static let maxScrolls = 30
    /// From the jump to its reply: longer than the service's own 30-second timeout, whose
    /// failure releases the focus sooner.
    static let replyLimit: Double = 35_000
    /// From the reply naming the focus to its row being shown.
    static let landLimit: Double = 10_000

    /// The feed's geometry, in its own coordinates (the viewport's top is 0): its height, the
    /// insets the scroll view keeps (header, home indicator), and how much of its bottom the
    /// composer and keyboard cover besides.
    struct Geometry: Equatable, Sendable {
        var viewport: Double
        var topInset: Double
        var bottomInset: Double
        var covered: Double

        /// What the reader sees: under the header, above the composer and keyboard.
        var visibleTop: Double { topInset }
        var visibleBottom: Double { viewport - bottomInset - covered }
    }

    /// A row's measured top and bottom, in the same coordinates as the geometry.
    struct Span: Equatable, Sendable {
        var top: Double
        var bottom: Double
    }

    enum Step: Equatable, Sendable {
        /// No focus is landing: the ordinary place-keeping applies.
        case none
        /// The focus's row isn't among the rows yet: hold the place, scroll nowhere.
        case wait
        /// Scroll to the row, aligning `anchor` (a unit-point fraction) of it and of the
        /// scrolled space; nil centres it, for a row not drawn yet whose height isn't known.
        case scroll(rowID: String, anchor: Double?)
        /// The row is in view: hold it where it is from here.
        case landed(rowID: String)
    }

    /// Whether a focus still owns the reader's place: no page, no end read, no other restore.
    var holdsPlace: Bool { target != nil }
    /// A focus is landing or a jump's reply is still to name one.
    var isActive: Bool { holdsPlace || awaitsReply }

    /// A jump was sent: aim at the item asked for (nil for a turn, whose item only the reply
    /// names) before the reply, since the window's rows can land first.
    mutating func jumped(to item: String?, now: Double) {
        aim(at: item)
        awaitsReply = true
        deadline = now + Self.replyLimit
    }

    /// The jump's reply names the item the bridge brought into view, or none. A reply to any
    /// other read (a page, a reopened session, a rebuild) changes nothing.
    mutating func replied(focus: String?, now: Double) {
        guard awaitsReply else { return }
        awaitsReply = false
        aim(at: focus)
        deadline = focus == nil ? nil : now + Self.landLimit
    }

    /// The jump failed or its window closed: nothing is coming to land.
    mutating func readFailed() { release() }

    /// The reader moved the feed: their place, not the focus's.
    mutating func readerTookOver() { release() }

    /// The feed's tick at the deadline: lets the place go when nothing else laid out.
    mutating func expire(now: Double) {
        if let deadline, now >= deadline { release() }
    }

    /// The next step for the focus, given the row now showing its item (nil until that row
    /// lands) and the row's frame (nil until it's drawn).
    mutating func step(row: String?, frame: Span?, in geometry: Geometry, now: Double) -> Step {
        expire(now: now)
        guard target != nil else { return .none }
        guard let row else { return .wait }
        if let frame, Self.shows(frame, in: geometry) {
            release()
            return .landed(rowID: row)
        }
        guard scrolls < Self.maxScrolls else {
            release()
            return .none
        }
        scrolls += 1
        return .scroll(rowID: row, anchor: frame.flatMap { Self.anchor(placing: $0, in: geometry) })
    }

    /// A new focus starts a fresh budget.
    private mutating func aim(at item: String?) {
        target = item
        scrolls = 0
    }

    private mutating func release() {
        aim(at: nil)
        awaitsReply = false
        deadline = nil
    }

    /// The row's middle is in the middle half of what the reader sees.
    private static func shows(_ frame: Span, in geometry: Geometry) -> Bool {
        let height = geometry.visibleBottom - geometry.visibleTop
        guard height > 0 else { return false }
        let middle = (frame.top + frame.bottom) / 2
        let centre = (geometry.visibleTop + geometry.visibleBottom) / 2
        return abs(middle - centre) <= height / 4
    }

    /// The anchor putting the row's middle at the middle of what the reader sees. The scroll
    /// aligns within the feed inside its insets, which still runs under the composer and
    /// keyboard, so centring there would leave the row hidden behind a large keyboard.
    private static func anchor(placing frame: Span, in geometry: Geometry) -> Double? {
        let height = frame.bottom - frame.top
        let centre = (geometry.visibleTop + geometry.visibleBottom) / 2
        return TranscriptAnchorPlacement.fraction(top: centre - height / 2 - geometry.topInset,
            viewport: geometry.viewport, topInset: geometry.topInset,
            bottomInset: geometry.bottomInset, rowHeight: height)
    }
}
