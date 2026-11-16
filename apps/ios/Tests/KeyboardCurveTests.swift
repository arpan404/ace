import Foundation
import Testing
@testable import Ace

/// The curve the composer and the transcript's end ride the keyboard on (#2170).
struct KeyboardCurveTests {
    /// The system's keyboard edge as drawn every 60th of a second after the notification over
    /// 311 pt moves on the iPhone 17 Pro simulator (iOS 26.1, a 0.383 s notified duration). The
    /// first frame is dropped: when it lands after the notification varies from run to run.
    private let opening: [Double] = [785, 740, 697, 660, 629, 605, 586, 571, 560, 551, 545, 541, 537, 535, 533]
    private let closing: [Double] = [557, 643, 684, 719, 748, 771, 789, 802, 812, 820, 825, 829, 832, 835, 836]
    private let duration = 0.3833

    /// Where the ride puts the composer's foot on `frame`, from `start` to `end`.
    private func ridden(_ frame: Int, from start: Double, to end: Double, delay: Double) -> Double {
        start + (end - start) * KeyboardCurve.progress(Double(frame) / 60, duration: duration, delay: delay)
    }

    @Test func anOpeningRideStaysWithTheKeyboardWithoutFallingUnderIt() {
        for (index, edge) in opening.enumerated() {
            let foot = ridden(index + 2, from: 840, to: 529, delay: KeyboardCurve.openingDelay)
            #expect(foot <= edge + 4, "frame \(index + 2): the keyboard's edge is at \(edge), the composer's foot at \(foot)")
            #expect(edge - foot <= 45, "frame \(index + 2): the composer runs \(edge - foot) pt ahead")
        }
    }

    @Test func aClosingRideStaysWithTheKeyboardWithoutFallingUnderIt() {
        for (index, edge) in closing.enumerated() {
            let foot = ridden(index + 2, from: 529, to: 840, delay: KeyboardCurve.closingDelay)
            #expect(foot <= edge + 4, "frame \(index + 2): the keyboard's edge is at \(edge), the composer's foot at \(foot)")
            #expect(edge - foot <= 45, "frame \(index + 2): the composer trails by \(edge - foot) pt")
        }
    }

    @Test func aRideWaitsForItsDelayThenOnlyGoesForward() {
        #expect(KeyboardCurve.progress(0.03, duration: duration, delay: 0.04) == 0)
        var last = 0.0
        for step in 1...60 {
            let progress = KeyboardCurve.progress(0.04 + Double(step) / 120, duration: duration, delay: 0.04)
            #expect(progress > last && progress <= 1)
            last = progress
        }
    }

    @Test func aRideSettlesWithinAboutTheNotifiedDuration() {
        #expect(!KeyboardCurve.settled(0.2, duration: duration, delay: 0.005, distance: 311))
        #expect(KeyboardCurve.settled(0.6, duration: duration, delay: 0.04, distance: 311))
    }

    @Test func aMoveWithNoDurationIsAtItsEndOnceItStarts() {
        #expect(KeyboardCurve.progress(0.05, duration: 0, delay: 0.04) == 1)
    }
}
