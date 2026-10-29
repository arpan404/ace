import Foundation

/// The pace a streaming message reaches markit. Each update may grow the message's row, and a
/// growing row lays the transcript out again and moves its live end, so a streaming message
/// changes 10 to 20 times a second rather than on every delta: often enough to read as live,
/// calm enough to leave the frame to scrolling and typing. Finished text is never held back.
///
/// Pure: the caller passes the time (seconds on any monotonic clock) and runs the waits it asks
/// for, then calls `due` once they elapse.
struct StreamPace: Equatable, Sendable {
    /// The fastest pace: 20 updates a second.
    static let fastest: TimeInterval = 0.05
    /// The slowest: 10 a second, when the main thread is busy and when motion is reduced.
    static let slowest: TimeInterval = 0.1

    enum Step: Equatable, Sendable {
        /// Draw this text now.
        case show(String)
        /// Call `due` after this many seconds; the latest text waits until then.
        case wait(TimeInterval)
        /// Nothing new to draw.
        case idle
    }

    /// Under Reduce Motion updates come at the slowest pace.
    var reduceMotion = false
    /// The text on screen.
    private(set) var shown: String?
    private var pending: String?
    /// When the next streaming update may be drawn.
    private var earliest = -TimeInterval.infinity
    private var interval = fastest

    /// Seconds from one update to the next, given how late the main thread came back for the last
    /// wait: four times that, within 50 to 100 ms.
    static func interval(late: TimeInterval, reduceMotion: Bool) -> TimeInterval {
        reduceMotion ? slowest : min(slowest, max(fastest, late * 4))
    }

    /// The streaming message's latest text, at `now`. The first text shows at once; later ones
    /// wait for their turn, and only the latest of those is drawn.
    mutating func push(_ text: String, now: TimeInterval) -> Step {
        pending = text
        return pump(now: now)
    }

    /// A wait asked for has elapsed at `now`, `late` seconds after it was due.
    mutating func due(now: TimeInterval, late: TimeInterval) -> Step {
        interval = Self.interval(late: late, reduceMotion: reduceMotion)
        return pump(now: now)
    }

    /// The message finished: its whole text shows now, whatever the pace.
    mutating func finish(_ text: String) -> Step {
        pending = nil
        earliest = -.infinity
        interval = Self.fastest
        guard text != shown else { return .idle }
        shown = text
        return .show(text)
    }

    private mutating func pump(now: TimeInterval) -> Step {
        guard let next = pending else { return .idle }
        if next == shown {
            pending = nil
            return .idle
        }
        if now < earliest { return .wait(earliest - now) }
        pending = nil
        shown = next
        earliest = now + (reduceMotion ? Self.slowest : interval)
        return .show(next)
    }
}
