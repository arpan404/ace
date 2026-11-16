import Foundation
import Testing
@testable import Ace

/// Reading a Core Animation timing at a moment: where the keyboard is drawn on a given frame.
struct AnimationTimingTests {
    @Test func aLinearCurveIsAsFarThroughAsTheTime() {
        for step in 0...10 {
            let t = Double(step) / 10
            #expect(abs(AnimationTiming.bezier(x1: 0, y1: 0, x2: 1, y2: 1, at: t) - t) < 1e-6)
        }
    }

    @Test func anEaseInOutCurveIsSlowAtBothEndsAndHalfWayAtHalfTime() {
        let at = { AnimationTiming.bezier(x1: 0.42, y1: 0, x2: 0.58, y2: 1, at: $0) }
        #expect(abs(at(0.5) - 0.5) < 1e-4)
        #expect(at(0.1) < 0.1)
        #expect(at(0.9) > 0.9)
        #expect(abs(at(0.2) + at(0.8) - 1) < 1e-4)
    }

    @Test func aCurveHoldsAtItsEndsOutsideItsTime() {
        #expect(AnimationTiming.bezier(x1: 0.25, y1: 0.1, x2: 0.25, y2: 1, at: -0.5) == 0)
        #expect(abs(AnimationTiming.bezier(x1: 0.25, y1: 0.1, x2: 0.25, y2: 1, at: 2) - 1) < 1e-9)
    }

    @Test func anOverdampedSpringClimbsToItsTargetWithoutPassingIt() {
        var last = 0.0
        for step in 1...200 {
            let p = AnimationTiming.spring(mass: 3, stiffness: 1000, damping: 500, initialVelocity: 0, elapsed: Double(step) / 60)
            #expect(p >= last && p <= 1)
            last = p
        }
        #expect(last > 0.99)
    }

    @Test func anUnderdampedSpringOvershootsThenSettles() {
        let at = { AnimationTiming.spring(mass: 1, stiffness: 300, damping: 6, initialVelocity: 0, elapsed: $0) }
        #expect((1...60).map { at(Double($0) / 60) }.max() ?? 0 > 1)
        #expect(abs(at(5) - 1) < 0.01)
    }

    @Test func aCriticallyDampedSpringStartsAtRestAndSettles() {
        let at = { AnimationTiming.spring(mass: 1, stiffness: 100, damping: 20, initialVelocity: 0, elapsed: $0) }
        #expect(at(0) == 0)
        #expect(at(0.01) < 0.01)
        #expect(abs(at(2) - 1) < 0.001)
    }

    @Test func aSpringReleasedTowardItsTargetMovesSoonerThanOneAtRest() {
        let resting = AnimationTiming.spring(mass: 1, stiffness: 100, damping: 20, initialVelocity: 0, elapsed: 0.02)
        let thrown = AnimationTiming.spring(mass: 1, stiffness: 100, damping: 20, initialVelocity: 5, elapsed: 0.02)
        #expect(thrown > resting)
    }
}
