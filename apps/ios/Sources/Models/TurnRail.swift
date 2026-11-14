import Foundation

/// The phone's turn rail: an outline of a long thread's turns on the transcript's edge that a
/// finger scrubs to jump to one, as the web's rail beside its transcript
/// (`apps/web/src/features/thread/long/turn-rail.tsx`, `rail-ordinals.ts`). Pure.
enum TurnRail {
    /// Turns before the rail shows: past three a thread is quicker to outline than to scroll.
    static let minTurns = 4
    /// The most ticks the rail ever draws, as the web's.
    static let maxTicks = 79
    /// The closest ticks may sit, in points: the rail shows fewer turns rather than crowd them.
    static let minSpacing: Double = 6

    /// Shown while the person reads away from the live end, or holds it.
    static func shows(turns: Int, behind: Bool, scrubbing: Bool) -> Bool {
        turns >= minTurns && (behind || scrubbing)
    }

    /// The turn the rail marks: the finger's while scrubbing, else a turn just picked (a jump,
    /// VoiceOver's adjust) until the reader next moves, else the one the reader is in.
    struct Selection: Equatable {
        private var picked: Int?
        mutating func pick(_ turn: Int) { picked = turn }
        /// A scroll settled somewhere new: the reader's place speaks for itself again.
        mutating func readerMoved() { picked = nil }
        func current(scrub: Int?, place: Place?, count: Int) -> Int {
            min(max(scrub ?? picked ?? place?.ordinal(of: count) ?? count, 1), max(count, 1))
        }
    }

    /// How many ticks fit `height` at the closest spacing.
    static func limit(height: Double) -> Int { max(2, Int(height / minSpacing) + 1) }

    /// The turns with a tick: spread evenly from the first to the newest, never more than
    /// `limit`, and always the turns in view (`current` through `last`, up to half the rail).
    static func ordinals(count: Int, current: Int, limit: Int = maxTicks, last: Int? = nil) -> [Int] {
        guard count > 0 else { return [] }
        let cap = max(2, min(limit, maxTicks))
        let from = max(1, min(count, current))
        let to = max(from, min(count, last ?? current))
        let inView = min(to - from + 1, max(1, cap / 2))
        let size = min(count, max(2, cap - inView))
        var ordinals = Set<Int>()
        for index in 0..<size {
            let spread = size == 1 ? 0 : (Double(index * (count - 1)) / Double(size - 1)).rounded()
            ordinals.insert(1 + Int(spread))
        }
        for ordinal in from..<(from + inView) { ordinals.insert(ordinal) }
        return ordinals.sorted()
    }

    /// The tick nearest `y` on a rail `height` tall whose ticks spread evenly over it.
    static func tick(at y: Double, height: Double, ticks: [Int]) -> Int? {
        guard let first = ticks.first else { return nil }
        guard ticks.count > 1, height > 0 else { return first }
        let step = height / Double(ticks.count - 1)
        let index = Int((y / step).rounded())
        return ticks[min(max(index, 0), ticks.count - 1)]
    }

    /// Where a tick sits on the rail, from its top.
    static func offset(of ordinal: Int, height: Double, ticks: [Int]) -> Double? {
        guard let index = ticks.firstIndex(of: ordinal) else { return nil }
        return ticks.count > 1 ? height * Double(index) / Double(ticks.count - 1) : 0
    }

    /// What a transcript row says about its turn: the person's ask starts one, a settled work
    /// log names its turn.
    enum Mark: Equatable {
        case ask
        case head(Int)
        case answer
    }

    /// Where the row at `top` sits: in a settled turn, or that many asks before the newest.
    enum Place: Equatable {
        case turn(Int)
        case beforeNewest(Int)
        /// The turn's ordinal in a thread of `count` turns.
        func ordinal(of count: Int) -> Int {
            switch self {
            case .turn(let ordinal): return ordinal
            case .beforeNewest(let asks): return max(1, count - asks)
            }
        }
    }

    /// The turn the row at `top` belongs to: the next settled log's turn, less one for each ask
    /// after `top` and before that log. A row past the last log is in the running turn, the
    /// newest, or one before it per ask that follows. Nil when nothing is held.
    static func readerPlace(_ rows: [Mark], top: Int) -> Place? {
        guard rows.indices.contains(top) else { return nil }
        var asks = 0
        for index in top..<rows.count {
            switch rows[index] {
            case .ask where index > top: asks += 1
            case .head(let ordinal): return .turn(max(1, ordinal - asks))
            default: continue
            }
        }
        return .beforeNewest(asks)
    }
}
