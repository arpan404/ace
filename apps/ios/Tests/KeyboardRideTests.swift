import Foundation
import Testing
@testable import Ace

/// The keyboard ride's frames: they run while a move does, and never outlive the ride (#2181).
@MainActor struct KeyboardRideTests {
    /// Frames delivered by hand, held the way the run loop holds a display link: strongly, until
    /// the handler answers false or the clock is stopped.
    final class ManualClock: KeyboardFrameClock {
        private var handler: (@MainActor (KeyboardFrame) -> Bool)?
        var ticking: Bool { handler != nil }
        func start(_ frame: @escaping @MainActor (KeyboardFrame) -> Bool) { handler = frame }
        func stop() { handler = nil }
        /// One frame at `time`: an answer of false ends the frames.
        func fire(at time: Double) {
            guard let handler else { return }
            if !handler(KeyboardFrame(now: time, shown: time + 1.0 / 30)) { self.handler = nil }
        }
    }

    @Test func aRideLetGoOfMidMoveStopsItsFrames() {
        let clock = ManualClock()
        var ride: KeyboardRide? = KeyboardRide(clock: clock)
        ride?.move(to: 300, foot: 840, start: 0, duration: 0.3833, animated: true)
        clock.fire(at: 1.0 / 60)
        #expect(clock.ticking, "the move is under way")
        ride = nil
        clock.fire(at: 2.0 / 60)
        #expect(!clock.ticking, "nothing is left to tick")
    }

    @Test func aMoveLandsAtItsTargetAndStopsItsFrames() {
        let clock = ManualClock()
        let ride = KeyboardRide(clock: clock)
        ride.move(to: 300, foot: 840, start: 0, duration: 0.3833, animated: true)
        for frame in 1...90 { clock.fire(at: Double(frame) / 60) }
        #expect(ride.lift == 300)
        #expect(ride.landings == 1)
        #expect(!clock.ticking)
    }

    @Test func finishingAMoveLandsItAtOnceAndStopsItsFrames() {
        let clock = ManualClock()
        let ride = KeyboardRide(clock: clock)
        ride.move(to: 300, foot: 840, start: 0, duration: 0.3833, animated: true)
        clock.fire(at: 1.0 / 60)
        ride.finish()
        #expect(ride.lift == 300)
        #expect(!ride.running)
        #expect(!clock.ticking)
    }

    @Test func aMoveWithoutMotionLandsWithoutFrames() {
        let clock = ManualClock()
        let ride = KeyboardRide(clock: clock)
        ride.move(to: 300, foot: 840, start: 0, duration: 0.3833, animated: false)
        #expect(ride.lift == 300)
        #expect(!clock.ticking)
    }
}
