import CoreGraphics
import Testing
@testable import Ace

/// When the feed takes the row at the top as the one to hold, in whatever order the scroll and
/// the rows report their geometry.
@Suite struct TranscriptCaptureScheduleTests {
    private func run(_ events: [TranscriptCaptureSchedule.Event]) -> [Bool] {
        var schedule = TranscriptCaptureSchedule()
        return events.map { schedule.next($0) }
    }

    @Test func aResizeAfterADragIsCorrectedAgainstWhereTheDragLeftTheReader() {
        // Three 100-point rows; the drag ends with b 100 points below the header.
        var rows = TranscriptRowFrames()
        for (index, id) in ["a", "b", "c"].enumerated() {
            _ = rows.record(id, frame: CGRect(x: 0, y: CGFloat(index) * 100, width: 320, height: 100))
        }
        _ = rows.scrolled(origin: 0)
        let target = rows.top("b", inset: 0)
        var schedule = TranscriptCaptureSchedule()
        let atIdle = schedule.next(.gestureEnded(reading: true))
        #expect(!atIdle)
        // No content frame changed with the drag. Later a above grows, and b's callback comes
        // before any origin report: b's displaced place must not become the target.
        _ = rows.record("a", frame: CGRect(x: 0, y: 0, width: 320, height: 160))
        _ = rows.record("b", frame: CGRect(x: 0, y: 160, width: 320, height: 100))
        let captured = schedule.next(.rowLaidOut)
        #expect(!captured)
        // The correction's own scroll then reports the origin: still no capture.
        let afterCorrection = schedule.next(.originReported(moving: false))
        #expect(!afterCorrection)
        let drift = TranscriptRowPlacement.drift(top: rows.top("b", inset: 0) ?? 0, target: target ?? 0)
        #expect(drift == 60)
    }

    @Test func theFirstSettledOriginAfterADragRefreshesTheCaptureOnce() {
        #expect(run([.gestureEnded(reading: true), .originReported(moving: false), .rowLaidOut, .originReported(moving: false)])
            == [false, true, false, false])
    }

    @Test func aScrollThePersonDidNotMakeNeverCapturesMidFlight() {
        #expect(run([.gestureEnded(reading: true), .scrollStarted, .originReported(moving: true), .originReported(moving: false)])
            == [false, false, false, false])
        #expect(run([.gestureEnded(reading: true), .originReported(moving: true)]) == [false, false])
    }

    @Test func aDragThatEndsFollowingTheEndLeavesNothingToCapture() {
        #expect(run([.gestureEnded(reading: false), .originReported(moving: false)]) == [false, false])
    }

    @Test func aNewGestureDropsWhatTheLastOneOwed() {
        #expect(run([.gestureEnded(reading: true), .gestureBegan, .originReported(moving: false)]) == [false, false, false])
        #expect(run([.jumped, .gestureBegan, .settled]) == [false, false, false])
    }

    @Test func aTurnJumpCapturesWhereItSettlesNotWhereItLeft() {
        // The animated jump reports the origin on its way; only its settling captures, once.
        #expect(run([.jumped, .originReported(moving: true), .rowLaidOut, .settled, .settled])
            == [false, false, false, true, false])
    }

    @Test func aTurnJumpOwnsTheTargetOverADragStillSettling() {
        #expect(run([.gestureEnded(reading: true), .jumped, .originReported(moving: false), .settled])
            == [false, false, false, true])
    }
}
