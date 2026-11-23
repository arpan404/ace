import CoreGraphics

/// Where each entry of the flipped transcript sits (ADR 0222). Physical coordinates: entry 0 is
/// the live end at y = 0 and older entries stack below it, so an older page extends the far edge.
///
/// Heights are measured per id and kept across window changes: a row that leaves with a page and
/// comes back, or is laid out again after a rotation of the window, starts at its last height
/// instead of an estimate. Pure.
struct TranscriptStackGeometry: Equatable, Sendable {
    private(set) var ids: [String] = []
    private var heights: [CGFloat] = []
    private var tops: [CGFloat] = []
    private var positions: [String: Int] = [:]
    private var measured: [String: CGFloat] = [:]
    private var measuredSum: CGFloat = 0
    /// The height of a row nothing is known about yet.
    var fallback: CGFloat = 120

    var count: Int { ids.count }
    var contentHeight: CGFloat { (tops.last ?? 0) + (heights.last ?? 0) }

    func position(of id: String) -> Int? { positions[id] }
    func top(at index: Int) -> CGFloat { tops[index] }
    func height(at index: Int) -> CGFloat { heights[index] }
    func top(of id: String) -> CGFloat? { positions[id].map { tops[$0] } }
    /// The last height measured for `id`, from this window or an earlier one.
    func measuredHeight(_ id: String) -> CGFloat? { measured[id] }

    /// Lays out `ids` in order. An id never measured takes `estimate`, then the mean of what has
    /// been measured, then `fallback`. Returns how far the scroll offset must move so `anchor`,
    /// an entry laid out before and after, stays where it was on screen; 0 without one.
    @discardableResult
    mutating func replace(_ ids: [String], estimate: (String) -> CGFloat? = { _ in nil },
                          keeping anchor: String? = nil) -> CGFloat {
        let before = anchor.flatMap { top(of: $0) }
        let mean = measured.isEmpty ? fallback : measuredSum / CGFloat(measured.count)
        self.ids = ids
        heights = ids.map { measured[$0] ?? estimate($0) ?? mean }
        positions = Dictionary(ids.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        restack(from: 0)
        guard let before, let anchor, let after = top(of: anchor) else { return 0 }
        return after - before
    }

    /// Records `id`'s measured height. Returns its change from the height it was laid out at, or
    /// nil when it didn't change or `id` isn't laid out.
    @discardableResult mutating func measure(_ id: String, height: CGFloat) -> CGFloat? {
        if let old = measured[id] { measuredSum -= old }
        measured[id] = height
        measuredSum += height
        guard let index = positions[id], heights[index] != height else { return nil }
        let change = height - heights[index]
        heights[index] = height
        restack(from: index + 1)
        return change
    }

    /// The entries whose frames meet `minY..<maxY`.
    func indices(from minY: CGFloat, to maxY: CGFloat) -> Range<Int> {
        guard !ids.isEmpty, maxY > minY else { return 0..<0 }
        let first = firstIndex(reaching: minY) ?? ids.count
        var last = first
        while last < ids.count, tops[last] < maxY { last += 1 }
        return first..<last
    }

    /// The first entry whose bottom lies past `y`: the entry at the viewport's physical top.
    func firstIndex(reaching y: CGFloat) -> Int? {
        var low = 0, high = ids.count
        while low < high {
            let mid = (low + high) / 2
            if tops[mid] + heights[mid] <= y { low = mid + 1 } else { high = mid }
        }
        return low < ids.count ? low : nil
    }

    /// An entry that changed height by `change` moves everything after it. When it starts above
    /// the viewport's physical top, the offset moves with it so what is on screen stays still.
    static func offsetAdjustment(entryTop: CGFloat, change: CGFloat, viewportTop: CGFloat) -> CGFloat {
        entryTop < viewportTop ? change : 0
    }

    private mutating func restack(from start: Int) {
        if tops.count != heights.count { tops = Array(repeating: 0, count: heights.count) }
        guard start < heights.count else { return }
        var y = start == 0 ? 0 : tops[start - 1] + heights[start - 1]
        for index in start..<heights.count {
            tops[index] = y
            y += heights[index]
        }
    }
}
