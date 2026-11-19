import CoreGraphics
import Foundation
import SwiftUI

/// A working Spade's eyes at a moment, as the web's `fx-spade-look` and `fx-spade-blink` move them
/// (`motion.css`, ADR 0127): the pupils glance up-left, then up-right, then back, every 2.8 s on the
/// web's ease-out; the eyes close to a slit and open again once every 5.6 s. Pure: the mark reads
/// it from the time its timeline gives.
enum SpadeMotion {
    /// One look around, and one blink, in seconds.
    static let lookCycle = 2.8
    static let blinkCycle = 5.6
    /// How far the pupils glance each way, in the face's 24-unit box.
    static let left = CGPoint(x: -1.1, y: -0.5)
    static let right = CGPoint(x: 1.1, y: -0.6)
    /// How open the eyes are at the middle of a blink.
    static let closed: CGFloat = 0.12

    /// Where the pupils are moved from their rest, `seconds` after the motion began.
    static func look(at seconds: Double) -> CGPoint {
        let t = phase(seconds, lookCycle)
        // The web's keyframes: rest to 18%, left by 26% and held to 44%, right by 52% and held to
        // 70%, back by 78%.
        switch t {
        case ..<0.18: return .zero
        case ..<0.26: return mix(.zero, left, easeOut((t - 0.18) / 0.08))
        case ..<0.44: return left
        case ..<0.52: return mix(left, right, easeOut((t - 0.44) / 0.08))
        case ..<0.70: return right
        case ..<0.78: return mix(right, .zero, easeOut((t - 0.70) / 0.08))
        default: return .zero
        }
    }

    /// How open the eyes are (1 open), `seconds` after the motion began: shut at half the cycle.
    static func blink(at seconds: Double) -> CGFloat {
        let t = phase(seconds, blinkCycle)
        switch t {
        case ..<0.46: return 1
        case ..<0.50: return 1 + (closed - 1) * easeInOut((t - 0.46) / 0.04)
        case ..<0.54: return closed + (1 - closed) * easeInOut((t - 0.50) / 0.04)
        default: return 1
        }
    }

    /// Where in each cycle the eyes move (fractions of it); between these they hold still.
    static let lookMoves: [ClosedRange<Double>] = [0.18...0.26, 0.44...0.52, 0.70...0.78]
    static let blinkMoves: [ClosedRange<Double>] = [0.46...0.54]
    /// How often the mark redraws while its eyes move.
    static let frame = 1.0 / 60

    /// The next moment the mark needs drawing after `seconds`: a frame later while the eyes move
    /// (landing on the end of the movement), else the start of the next movement. Between
    /// movements nothing redraws.
    static func nextTick(after seconds: Double) -> Double {
        min(nextTick(after: seconds, cycle: lookCycle, moves: lookMoves),
            nextTick(after: seconds, cycle: blinkCycle, moves: blinkMoves))
    }

    private static func nextTick(after seconds: Double, cycle: Double, moves: [ClosedRange<Double>]) -> Double {
        let base = (seconds / cycle).rounded(.down) * cycle
        // This cycle's movements and the next cycle's first, in seconds.
        let windows = moves.map { (base + $0.lowerBound * cycle, base + $0.upperBound * cycle) }
            + [(base + cycle + moves[0].lowerBound * cycle, base + cycle + moves[0].upperBound * cycle)]
        for (start, end) in windows {
            if seconds < start { return start }
            if seconds < end { return min(seconds + frame, end) }
        }
        return base + cycle + moves[0].lowerBound * cycle
    }

    /// The mark's timeline: display-rate frames only while the eyes move.
    struct Schedule: TimelineSchedule {
        func entries(from startDate: Date, mode: TimelineScheduleMode) -> UnfoldFirstSequence<Date> {
            sequence(first: startDate) { date in
                Date(timeIntervalSinceReferenceDate: SpadeMotion.nextTick(after: date.timeIntervalSinceReferenceDate))
            }
        }
    }

    private static func phase(_ seconds: Double, _ cycle: Double) -> Double {
        let t = seconds.truncatingRemainder(dividingBy: cycle) / cycle
        return t < 0 ? t + 1 : t
    }
    /// The web's `--ease-out`, `cubic-bezier(0.2, 0.8, 0.2, 1)`.
    private static func easeOut(_ t: Double) -> CGFloat {
        CGFloat(AnimationTiming.bezier(x1: 0.2, y1: 0.8, x2: 0.2, y2: 1, at: t))
    }
    /// CSS `ease-in-out`.
    private static func easeInOut(_ t: Double) -> CGFloat {
        CGFloat(AnimationTiming.bezier(x1: 0.42, y1: 0, x2: 0.58, y2: 1, at: t))
    }
    private static func mix(_ a: CGPoint, _ b: CGPoint, _ k: CGFloat) -> CGPoint {
        CGPoint(x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k)
    }
}
