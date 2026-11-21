import CoreGraphics
import Foundation

/// Where the chosen fill sits in a row of equal places (`GlidingPlaces`), as the system's tab bar
/// moves it: under the finger while it slides along the bar, then on the place nearest it.
/// Positions are in the row's own space: 0 at its leading edge, `width` at its trailing one.
struct TabGlide: Equatable {
    /// How many places the row holds.
    let count: Int
    /// The row's width, inside the capsule's inset.
    let width: CGFloat
    /// The gap between two places.
    let spacing: CGFloat

    /// One place's width, and the fill's.
    var slot: CGFloat {
        guard count > 0 else { return 0 }
        return max((width - spacing * CGFloat(count - 1)) / CGFloat(count), 0)
    }

    /// The fill's leading edge on place `index`, clamped to the row's places.
    func offset(of index: Int) -> CGFloat { step * CGFloat(clamped(index)) }

    /// The fill's leading edge with the finger at `x`: centred under it, and held inside the row
    /// when the finger runs past either end.
    func offset(following x: CGFloat) -> CGFloat { min(max(x - slot / 2, 0), offset(of: count - 1)) }

    /// The place under the finger at `x`, and so the one a release there chooses: each place owns
    /// its slot and half the gap either side; past the ends, the end place.
    func index(at x: CGFloat) -> Int {
        guard step > 0 else { return 0 }
        return clamped(Int(((x + spacing / 2) / step).rounded(.down)))
    }

    /// How far a finger may move, in any direction, and still count as a tap.
    static let tapSlop: CGFloat = 10
    /// How long a finger may stay down and still count as a tap.
    static let tapTime: TimeInterval = 0.5

    /// What a finger lifted at `end`, having touched down at `start` `held` seconds before, picks:
    /// the place under it; nothing when a slide or a swipe off the bar ends over the place already
    /// chosen (`chosen`). A short tap on that place still picks it, which takes its list back to
    /// the top.
    func release(from start: CGPoint, at end: CGPoint, held: TimeInterval, chosen: Int) -> Int? {
        let picked = index(at: end.x)
        let tap = hypot(end.x - start.x, end.y - start.y) < Self.tapSlop && held < Self.tapTime
        return picked != chosen || tap ? picked : nil
    }

    private var step: CGFloat { slot + spacing }
    private func clamped(_ index: Int) -> Int { min(max(index, 0), max(count - 1, 0)) }
}
