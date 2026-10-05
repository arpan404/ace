import XCTest
@testable import ScreenHelper

final class PipelineTests: XCTestCase {
    func testFinalChangedFrameIsSubmittedWhenEncoderCompletesEvenWithNoMoreCapture() {
        var busy = false
        var pixels: [Int] = []
        let frames = LatestVideoFrames<Int> { image in
            if busy { return .busy }
            busy = true; pixels.append(image); return .submitted
        }
        frames.offer(1)
        for value in 2...100 { frames.offer(value) }
        XCTAssertEqual(pixels, [1])
        busy = false; frames.completed()
        XCTAssertEqual(pixels, [1, 100])
        frames.clear(); busy = false; frames.completed()
        XCTAssertEqual(pixels, [1, 100])
    }
    func testScreenshotRequestedWithoutCachedPixelsIsFulfilledOnTheNextCaptureAfterResume() {
        let images = CaptureImages<Int>()
        XCTAssertNil(images.request())
        XCTAssertEqual(images.receive(10), 10)
        XCTAssertNil(images.receive(11))
        XCTAssertEqual(images.request(), 11)
        images.clear()
        XCTAssertNil(images.request())
        XCTAssertEqual(images.receive(12), 12)
    }
    func testFailedReleaseRetainsOriginalTargetUntilSuccessfulMouseUpOrConfirmedDestruction() throws {
        let pointer = HeldPointer<Int>()
        pointer.hold(42)
        var allowed = false
        var released: [Int] = []
        func cancel() throws {
            try pointer.release { target in
                try NativeInputPost.perform(permission: { allowed }) { released.append(target) }
            }
        }
        XCTAssertThrowsError(try cancel())
        allowed = true
        try cancel(); try cancel()
        XCTAssertEqual(released, [42])
        pointer.hold(43)
        pointer.targetDestroyed()
        try cancel()
        XCTAssertEqual(released, [42])
    }
    func testRevokedPermissionPreventsEveryNativePostIncludingCleanup() {
        var posted = false
        XCTAssertThrowsError(try InputPermission.require(false))
        do { try NativeInputPost.perform(permission: { false }) { posted = true } } catch {}
        XCTAssertFalse(posted)
    }
}
