import CoreGraphics

/// Where each shown transcript row sits, kept in the scroll content's own coordinates.
///
/// A row's place in the content changes only when it or a row above it changes height; a scroll
/// moves the content's origin, which is one number. So scrolling costs nothing per row, and a
/// row's place on screen is worked out from the two when something asks for it (#2051: rows that
/// reported their frame on screen ran their geometry action on every frame of every scroll).
struct TranscriptRowFrames: Equatable, Sendable {
    /// What recording a row's frame in the content found.
    enum Change: Equatable, Sendable {
        /// Same place, same height: nothing to do.
        case unchanged
        /// Same height in another place: a row above it changed.
        case moved
        /// Another height than last recorded.
        case resized
        /// Not recorded since it last left the screen.
        case appeared
    }

    private var content: [String: CGRect] = [:]
    /// The content's top in viewport coordinates: the scroll offset, negated.
    private(set) var origin: CGFloat = 0

    mutating func record(_ id: String, frame: CGRect) -> Change {
        let last = content.updateValue(frame, forKey: id)
        guard let last else { return .appeared }
        if last.height != frame.height { return .resized }
        return last == frame ? .unchanged : .moved
    }

    /// The row left the screen.
    mutating func forget(_ id: String) { content[id] = nil }

    /// The content's top moved to `origin` in the viewport. True when it moved.
    mutating func scrolled(origin next: CGFloat) -> Bool {
        guard next != origin else { return false }
        origin = next
        return true
    }

    /// The height of each row on screen.
    var heights: [String: CGFloat] { content.mapValues(\.height) }

    /// The row's frame in the content, if it's on screen: a scroll leaves it alone.
    func inContent(_ id: String) -> CGRect? { content[id] }

    /// The row's frame in viewport coordinates, if it's on screen.
    func frame(_ id: String) -> CGRect? {
        content[id]?.offsetBy(dx: 0, dy: origin)
    }

    /// How far the row's top is below the viewport's top `inset` (the header).
    func top(_ id: String, inset: CGFloat) -> Double? {
        frame(id).map { Double($0.minY - inset) }
    }

    /// Of the rows on screen, the highest one showing below the top `inset`.
    func topRow(inset: CGFloat) -> String? {
        topRow(of: content.keys.sorted(), inset: inset)
    }

    /// Of the rows in `order`, the highest one showing below the top `inset`.
    func topRow(of order: [String], inset: CGFloat) -> String? {
        var best: (id: String, top: CGFloat)?
        for id in order {
            guard let frame = frame(id), frame.maxY > inset + 1 else { continue }
            if best.map({ frame.minY < $0.top }) ?? true { best = (id, frame.minY) }
        }
        return best?.id
    }
}

/// How close a held row must sit to where it belongs before the feed leaves it alone.
enum TranscriptRowPlacement {
    static let tolerance = 2.0

    /// How far `top` is from `target`, or nil when it's within the tolerance.
    static func drift(top: Double, target: Double) -> Double? {
        let drift = top - target
        return abs(drift) > tolerance ? drift : nil
    }

    static func settled(top: Double, target: Double) -> Bool {
        drift(top: top, target: target) == nil
    }
}
