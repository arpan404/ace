/// When the transcript can be shown after a change it would otherwise draw in steps: a thread
/// opening, whose lazy rows measure and whose scroll reaches the end over a few frames, or an
/// older page landing above the reader's line. The feed is hidden (or frozen) meanwhile, then shown
/// where it ended up, so the reader never sees the steps.
///
/// Each drawn frame gives the numbers that must hold still (content height, offset, a row's top).
/// It settles once they have stayed within half a point for `stillFrames` frames in a row, with
/// the feed where it belongs, and gives up waiting after `limit` seconds. Pure: the caller passes
/// each frame's time.
struct TranscriptSettle: Equatable, Sendable {
    /// Frames in a row that must match the one before.
    static let stillFrames = 2
    /// The longest the feed stays hidden, in seconds.
    static let limit = 0.25
    /// Moves smaller than this, in points, are rounding.
    static let tolerance = 0.5

    enum Outcome: Equatable, Sendable {
        case waiting
        /// Held still for `stillFrames` frames.
        case settled
        /// Still moving at `limit`: shown as it is.
        case capped
    }

    private let started: Double
    private var last: [Double]?
    private var still = 0

    init(at time: Double) { started = time }

    /// One drawn frame's `values`. `placed` is false while the feed isn't yet where it belongs
    /// (short of the end it follows), which keeps it from settling.
    mutating func frame(_ values: [Double], placed: Bool = true, at time: Double) -> Outcome {
        defer { last = values }
        let unchanged = last.map { Self.matches($0, values) } ?? false
        still = unchanged && placed ? still + 1 : 0
        if still >= Self.stillFrames { return .settled }
        return time - started >= Self.limit ? .capped : .waiting
    }

    /// Whether an opening feed is where it opens: at its end when `following` it (`fromEnd` is
    /// how far the end is below the bottom edge), and not while a saved place is `restoring`:
    /// still being fetched or put back.
    static func opened(following: Bool, fromEnd: Double, restoring: Bool) -> Bool {
        !restoring && (!following || fromEnd <= 1)
    }

    private static func matches(_ a: [Double], _ b: [Double]) -> Bool {
        a.count == b.count && zip(a, b).allSatisfy { abs($0 - $1) < tolerance }
    }
}
