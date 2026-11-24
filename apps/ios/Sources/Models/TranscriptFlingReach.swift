/// Where a released fling comes to rest and how much of its travel is left, at UIKit's normal
/// deceleration (0.998 of the speed kept each millisecond). Physical offsets: they grow toward
/// older rows. Pure.
struct TranscriptFlingReach: Equatable, Sendable {
    private static let kept = 0.998
    /// The offset the fling rests at.
    let stop: Double
    /// 1 toward older rows, -1 toward the live end.
    private let sign: Double

    /// A fling released at `offset` with `velocity` points a second.
    init(offset: Double, velocity: Double) {
        stop = offset + velocity / 1000 * Self.kept / (1 - Self.kept)
        sign = velocity < 0 ? -1 : 1
    }

    /// How far the fling still carries from `offset`; 0 once it has got there.
    func remaining(at offset: Double) -> Double {
        max(0, (stop - offset) * sign)
    }
}
