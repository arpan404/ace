import CoreGraphics
import Testing
@testable import Ace

/// A working Spade's eyes, timed as the web's `fx-spade-look` and `fx-spade-blink`.
struct SpadeMotionTests {
    private func near(_ a: CGPoint, _ b: CGPoint) -> Bool { abs(a.x - b.x) < 1e-6 && abs(a.y - b.y) < 1e-6 }

    @Test func thePupilsRestThenGlanceLeftThenRightThenComeBackEachLook() {
        let cycle = SpadeMotion.lookCycle
        #expect(near(SpadeMotion.look(at: 0.1 * cycle), .zero))
        #expect(near(SpadeMotion.look(at: 0.35 * cycle), SpadeMotion.left))
        #expect(near(SpadeMotion.look(at: 0.6 * cycle), SpadeMotion.right))
        #expect(near(SpadeMotion.look(at: 0.9 * cycle), .zero))
        // Both glances are upward and to opposite sides.
        #expect(SpadeMotion.left.x < 0 && SpadeMotion.right.x > 0)
        #expect(SpadeMotion.left.y < 0 && SpadeMotion.right.y < 0)
    }

    @Test func aGlanceMovesSmoothlyRatherThanJumping() {
        let cycle = SpadeMotion.lookCycle
        var last = SpadeMotion.look(at: 0.18 * cycle).x
        for step in 1...40 {
            let x = SpadeMotion.look(at: (0.18 + 0.08 * Double(step) / 40) * cycle).x
            #expect(x <= last && last - x < 0.25)
            last = x
        }
        #expect(abs(last - SpadeMotion.left.x) < 1e-6)
    }

    @Test func theEyesShutToASlitOncePerBlinkAndAreOpenOtherwise() {
        let cycle = SpadeMotion.blinkCycle
        #expect(abs(SpadeMotion.blink(at: 0.5 * cycle) - SpadeMotion.closed) < 1e-6)
        for t in [0.0, 0.2, 0.45, 0.55, 0.8, 0.99] {
            #expect(SpadeMotion.blink(at: t * cycle) == 1)
        }
        let closing = SpadeMotion.blink(at: 0.48 * cycle)
        #expect(closing < 1 && closing > SpadeMotion.closed)
    }

    @Test func theMotionRepeatsEveryCycle() {
        for t in [0.3, 1.1, 2.0] {
            #expect(near(SpadeMotion.look(at: t), SpadeMotion.look(at: t + 3 * SpadeMotion.lookCycle)))
            #expect(abs(SpadeMotion.blink(at: t + 2.75) - SpadeMotion.blink(at: t + 2.75 + SpadeMotion.blinkCycle)) < 1e-9)
        }
    }

    @Test func betweenMovementsTheMarkAsksForNoFramesUntilTheNextOneStarts() {
        let look = SpadeMotion.lookCycle
        // Resting at the start of a look cycle (a blink is far off): the next frame is the glance.
        let cycle = 10 * SpadeMotion.blinkCycle
        let next = SpadeMotion.nextTick(after: cycle + 0.05 * look)
        #expect(abs(next - (cycle + 0.18 * look)) < 1e-9)
        // Holding the left glance: nothing until it moves on to the right.
        let held = SpadeMotion.nextTick(after: cycle + 0.35 * look)
        #expect(abs(held - (cycle + 0.44 * look)) < 1e-9)
    }

    @Test func whileTheEyesMoveTheMarkTicksAtDisplayRateAndLandsOnTheMovementsEnd() {
        let look = SpadeMotion.lookCycle
        let cycle = 10 * SpadeMotion.blinkCycle
        var t = cycle + 0.18 * look
        var frames = 0
        while t < cycle + 0.26 * look - 1e-9 {
            let next = SpadeMotion.nextTick(after: t)
            #expect(next - t <= SpadeMotion.frame + 1e-9)
            t = next
            frames += 1
        }
        #expect(abs(t - (cycle + 0.26 * look)) < 1e-9)
        // About the glance's length in frames, not one per second of the whole cycle.
        #expect(frames >= 13 && frames <= 15)
        // The glance's last frame shows it finished.
        #expect(near(SpadeMotion.look(at: t), SpadeMotion.left))
    }

    @Test func overAWholeBlinkCycleTheMarkDrawsOnlyAFractionOfTheFrames() {
        let start = 20 * SpadeMotion.blinkCycle
        var t = start, frames = 0
        while t < start + SpadeMotion.blinkCycle { t = SpadeMotion.nextTick(after: t); frames += 1 }
        let everyFrame = Int(SpadeMotion.blinkCycle / SpadeMotion.frame)
        #expect(frames < everyFrame / 2)
        #expect(frames > 0)
    }
}
