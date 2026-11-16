import Foundation
import Testing
@testable import Ace

/// The curve the transcript's end rides the keyboard on (#2170).
struct KeyboardCurveTests {
    /// The composer's top as drawn every 60th of a second from the keyboard notification, opening
    /// over a 311 pt move on the iPhone 17 Pro simulator (iOS 26.1, a 0.383 s notified duration).
    private let drawn: [Double] = [788, 776, 716, 671, 630, 596, 567, 544, 527, 514, 504, 497, 491, 487, 484, 482, 481]

    @Test func theCurveFollowsTheKeyboardAsTheSystemDrawsIt() {
        let start = drawn[0], end = 477.0
        for (frame, y) in drawn.enumerated() {
            let modelled = start + (end - start) * KeyboardCurve.progress(Double(frame) / 60, duration: 0.3833)
            #expect(abs(modelled - y) <= 10, "frame \(frame): drawn at \(y), the curve puts it at \(modelled)")
        }
    }

    @Test func theMoveStartsAtTheNotificationAndOnlyGoesForward() {
        #expect(KeyboardCurve.progress(0, duration: 0.3833) == 0)
        var last = 0.0
        for step in 1...60 {
            let progress = KeyboardCurve.progress(Double(step) / 120, duration: 0.3833)
            #expect(progress > last && progress <= 1)
            last = progress
        }
    }

    @Test func aMoveSettlesWithinAboutTheNotifiedDuration() {
        #expect(!KeyboardCurve.settled(0.2, duration: 0.3833, distance: 311))
        #expect(KeyboardCurve.settled(0.5, duration: 0.3833, distance: 311))
    }

    @Test func aMoveWithNoDurationIsAtItsEndAtOnce() {
        #expect(KeyboardCurve.progress(0.01, duration: 0) == 1)
    }
}
