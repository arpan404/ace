import XCTest
import CoreVideo
@testable import ScreenHelper

/// An encoder that holds each picture until the test completes it, as a slow hardware encode does.
private final class HeldEncoder: TranscodeEncoder {
    struct Encoded: Equatable { let seq: UInt64; let width: Int; let keyframe: Bool }
    var encoded: [Encoded] = []
    var busyNow = false
    private var keyframe = false
    func encode(_ image: CVPixelBuffer, sequence: UInt64, timestamp: Double, scale: Double, at: UInt64, quality: StreamQuality) -> VideoEncodeResult {
        if busyNow { return .busy }
        busyNow = true
        encoded.append(Encoded(seq: sequence, width: CVPixelBufferGetWidth(image), keyframe: keyframe))
        keyframe = false
        return .submitted
    }
    func requestKeyframe() { keyframe = true }
    func retune(bitrate: Int) {}
    func close() {}
    /// The encode finished, or rate control dropped it: either way the encoder is free.
    func finish(_ state: TranscodeState) { busyNow = false; state.completed() }
}

private func image(width: Int = 640, height: Int = 1280) -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    let attributes: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
    CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attributes as CFDictionary, &buffer)
    return buffer!
}

final class TranscoderTests: XCTestCase {
    func testTheLastChangeBeforeTheScreenGoesStillIsEncodedWhenTheBusyEncoderFinishes() {
        let encoder = HeldEncoder()
        let state = TranscodeState(encoder: encoder, now: { 0 })
        state.picture(image(), seq: 1, ts: 1)
        // The encoder is still on picture 1 when the screen's final changes arrive.
        state.picture(image(), seq: 2, ts: 2)
        state.picture(image(), seq: 3, ts: 3)
        XCTAssertEqual(encoder.encoded.map(\.seq), [1])
        // No more pictures come: the Simulator is still. Finishing 1 must still bring 3.
        encoder.finish(state)
        XCTAssertEqual(encoder.encoded.map(\.seq), [1, 3])
        encoder.finish(state)
        XCTAssertEqual(encoder.encoded.map(\.seq), [1, 3])
    }

    func testAPictureRateControlDroppedStillLetsTheWaitingOneThrough() {
        let encoder = HeldEncoder()
        let state = TranscodeState(encoder: encoder, now: { 0 })
        state.picture(image(), seq: 1, ts: 1)
        state.picture(image(), seq: 2, ts: 2)
        // Rate control drops picture 1 (no sample comes out); the encoder still completes it.
        encoder.encoded.removeAll()
        encoder.finish(state)
        XCTAssertEqual(encoder.encoded.map(\.seq), [2])
    }

    func testAKeyframeRequestOnAStillScreenEncodesTheLastPictureAsAKeyframe() {
        let encoder = HeldEncoder()
        let state = TranscodeState(encoder: encoder, now: { 0 })
        state.picture(image(), seq: 1, ts: 1)
        encoder.finish(state)
        state.handle(["op": "keyframe"], Data())
        XCTAssertEqual(encoder.encoded, [.init(seq: 1, width: 640, keyframe: false), .init(seq: 1, width: 640, keyframe: true)])
    }

    func testASmallerViewerBoxOnAStillScreenSendsTheLastPictureAtTheNewSize() {
        let encoder = HeldEncoder()
        let state = TranscodeState(encoder: encoder, now: { 0 })
        state.picture(image(), seq: 1, ts: 1)
        encoder.finish(state)
        state.handle(["op": "settings", "maxWidth": 320, "maxHeight": 640], Data())
        XCTAssertEqual(encoder.encoded.map(\.width), [640, 320])
        // The same box again changes nothing, so nothing is sent again.
        encoder.finish(state)
        state.handle(["op": "settings", "maxWidth": 320, "maxHeight": 640], Data())
        XCTAssertEqual(encoder.encoded.count, 2)
    }
}
