import XCTest
import CoreVideo
@testable import ScreenHelper

final class TranscoderTests: XCTestCase {
    func testTheLastChangeBeforeTheScreenGoesStillIsEncodedWhenTheBusyEncoderFinishes() {
        let encoder = HeldEncoder()
        let state = TranscodeState(encoder: encoder, now: { 0 })
        state.picture(blankPicture(), seq: 1, ts: 1)
        // The encoder is still on picture 1 when the screen's final changes arrive.
        state.picture(blankPicture(), seq: 2, ts: 2)
        state.picture(blankPicture(), seq: 3, ts: 3)
        XCTAssertEqual(encoder.encoded.map(\.seq), [1])
        // No more pictures come: the Simulator is still. Finishing 1 must still bring 3.
        encoder.finish(state.completed)
        XCTAssertEqual(encoder.encoded.map(\.seq), [1, 3])
        encoder.finish(state.completed)
        XCTAssertEqual(encoder.encoded.map(\.seq), [1, 3])
    }

    func testAPictureRateControlDroppedStillLetsTheWaitingOneThrough() {
        let encoder = HeldEncoder()
        let state = TranscodeState(encoder: encoder, now: { 0 })
        state.picture(blankPicture(), seq: 1, ts: 1)
        state.picture(blankPicture(), seq: 2, ts: 2)
        // Rate control drops picture 1 (no sample comes out); the encoder still completes it.
        encoder.encoded.removeAll()
        encoder.finish(state.completed)
        XCTAssertEqual(encoder.encoded.map(\.seq), [2])
    }

    func testAKeyframeRequestOnAStillScreenEncodesTheLastPictureAsAKeyframe() {
        let encoder = HeldEncoder()
        let state = TranscodeState(encoder: encoder, now: { 0 })
        state.picture(blankPicture(), seq: 1, ts: 1)
        encoder.finish(state.completed)
        state.handle(["op": "keyframe"], Data())
        XCTAssertEqual(encoder.encoded, [.init(seq: 1, width: 640, keyframe: false), .init(seq: 1, width: 640, keyframe: true)])
    }

    func testASmallerViewerBoxOnAStillScreenSendsTheLastPictureAtTheNewSize() {
        let encoder = HeldEncoder()
        let state = TranscodeState(encoder: encoder, now: { 0 })
        state.picture(blankPicture(), seq: 1, ts: 1)
        encoder.finish(state.completed)
        state.handle(["op": "settings", "maxWidth": 320, "maxHeight": 640], Data())
        XCTAssertEqual(encoder.encoded.map(\.width), [640, 320])
        // The same box again changes nothing, so nothing is sent again.
        encoder.finish(state.completed)
        state.handle(["op": "settings", "maxWidth": 320, "maxHeight": 640], Data())
        XCTAssertEqual(encoder.encoded.count, 2)
    }
}
