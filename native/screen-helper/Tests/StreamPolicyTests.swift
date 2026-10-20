import XCTest
import CoreGraphics
@testable import ScreenHelper

final class StreamPolicyTests: XCTestCase {
    func testLiveViewCapturesAtNativePixelsWhenTheViewerAsksForMore() {
        let size = streamCaptureSize(points: CGSize(width: 800, height: 600), density: 2, maxWidth: 3840, maxHeight: 3840)
        XCTAssertEqual(size.width, 1600)
        XCTAssertEqual(size.height, 1200)
    }
    func testLiveViewFollowsASmallerViewerWithEvenDimensions() {
        let size = streamCaptureSize(points: CGSize(width: 801, height: 601), density: 2, maxWidth: 801, maxHeight: 3840)
        XCTAssertEqual(size.width, 800)
        XCTAssertEqual(size.height, 600)
    }
    func testOneXDisplayIsNeverUpscaled() {
        let size = streamCaptureSize(points: CGSize(width: 1920, height: 1080), density: 1, maxWidth: 3840, maxHeight: 3840)
        XCTAssertEqual(size.width, 1920)
        XCTAssertEqual(size.height, 1080)
    }
    func testMotionFramesLeaveQuantisationToRateControl() {
        let motion = videoEncoderSettings(.motion, bitrate: 6_000_000, width: 1600, height: 1000)
        XCTAssertNil(motion.maxFrameQP)
        XCTAssertFalse(motion.keyframe)
    }
    func testRefineIsAKeyframeFinerOnFasterLinks() {
        let local = videoEncoderSettings(.refine, bitrate: 6_000_000, width: 1600, height: 1000)
        let relay = videoEncoderSettings(.refine, bitrate: 1_200_000, width: 1600, height: 1000)
        XCTAssertTrue(local.keyframe)
        XCTAssertTrue(relay.keyframe)
        XCTAssertLessThan(local.maxFrameQP ?? 99, relay.maxFrameQP ?? 0)
    }
    func testHugePicturesOnSlowLinksStillRefineAtTheCoarsestCap() {
        XCTAssertEqual(refineFrameQP(bitrate: 128_000, pixels: 3840 * 2160), refineBytesPerPixel.last?.qp)
    }
    func testStillJPEGsAreEncodedFinerThanMovingOnes() {
        XCTAssertGreaterThan(jpegQuality(.refine), jpegQuality(.motion))
    }
    func testOneRefineIsDueAfterThePictureHoldsStill() {
        var refine = RefineOnIdle(idleNs: 300)
        XCTAssertFalse(refine.due(at: 1_000))
        XCTAssertNil(refine.wakeAt)
        refine.changed(at: 1_000)
        XCTAssertEqual(refine.wakeAt, 1_300)
        XCTAssertFalse(refine.due(at: 1_299))
        XCTAssertTrue(refine.due(at: 1_300))
        refine.sent()
        XCTAssertFalse(refine.due(at: 5_000))
        XCTAssertNil(refine.wakeAt)
        XCTAssertTrue(refine.still)
    }
    func testEachChangeRestartsTheIdleClock() {
        var refine = RefineOnIdle(idleNs: 300)
        refine.changed(at: 1_000)
        refine.changed(at: 1_200)
        XCTAssertFalse(refine.due(at: 1_400))
        XCTAssertTrue(refine.due(at: 1_500))
        XCTAssertFalse(refine.still)
    }
    func testARefineTheEncoderCouldNotTakeStaysDue() {
        var refine = RefineOnIdle(idleNs: 300)
        refine.changed(at: 0)
        XCTAssertTrue(refine.due(at: 400))
        XCTAssertTrue(refine.due(at: 900))
    }
    func testAChangeAfterARefineGoesBackToMotion() {
        var refine = RefineOnIdle(idleNs: 300)
        refine.changed(at: 0)
        refine.sent()
        refine.changed(at: 1_000)
        XCTAssertFalse(refine.still)
        XCTAssertTrue(refine.due(at: 1_300))
    }
    func testARestartedStreamHasNothingPending() {
        var refine = RefineOnIdle(idleNs: 300)
        refine.changed(at: 0)
        refine.reset()
        XCTAssertFalse(refine.due(at: 1_000))
        XCTAssertFalse(refine.still)
    }
    func testStartCodesReplaceEveryNALLengthAndRejectBadLengths() {
        var packet = Data([9, 9, 0, 0, 0, 2, 0x65, 1, 0, 0, 0, 1, 0x41])
        XCTAssertTrue(VideoEncoder.startCodes(&packet, from: 2))
        XCTAssertEqual([UInt8](packet), [9, 9, 0, 0, 0, 1, 0x65, 1, 0, 0, 0, 1, 0x41])
        var broken = Data([0, 0, 0, 9, 0x65])
        XCTAssertFalse(VideoEncoder.startCodes(&broken, from: 0))
    }
}
