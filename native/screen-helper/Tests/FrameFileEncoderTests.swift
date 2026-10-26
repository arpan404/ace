import XCTest
import CoreVideo
@testable import ScreenHelper

final class FrameFileEncoderTests: XCTestCase {
    /// Pictures the emulator wrote, read from the shared file when the encoder takes them.
    private func setup() -> (state: FrameFileState, encoder: HeldEncoder, reads: () -> [UInt64]) {
        let encoder = HeldEncoder()
        var reads: [UInt64] = []
        let state = FrameFileState(encoder: encoder, picture: { note in
            reads.append(note.seq)
            return blankPicture(width: note.width, height: note.height)
        }, now: { 0 })
        return (state, encoder, { reads })
    }
    private func note(_ seq: UInt64) -> FrameNote { FrameNote(seq: seq, width: 640, height: 1280, ts: Double(seq)) }

    func testAKeyframeRequestOnAStillEmulatorScreenEncodesTheLastPictureAsAKeyframe() {
        let (state, encoder, reads) = setup()
        state.frame(note(1))
        encoder.finish(state.completed)
        // The emulator writes nothing more: the screen is still.
        state.keyframe()
        XCTAssertEqual(encoder.encoded, [.init(seq: 1, width: 640, keyframe: false), .init(seq: 1, width: 640, keyframe: true)])
        // The picture as it was encoded, not the file again (it may hold another picture by now).
        XCTAssertEqual(reads(), [1])
    }

    func testAKeyframeRequestNeverReplacesANewerPictureThatWaits() {
        let (state, encoder, _) = setup()
        state.frame(note(1))
        state.frame(note(2))
        state.keyframe()
        encoder.finish(state.completed)
        XCTAssertEqual(encoder.encoded, [.init(seq: 1, width: 640, keyframe: false), .init(seq: 2, width: 640, keyframe: true)])
    }

    func testTheLastChangeBeforeTheEmulatorGoesStillIsEncodedWhenTheBusyEncoderFinishes() {
        let (state, encoder, _) = setup()
        state.frame(note(1))
        state.frame(note(2))
        state.frame(note(3))
        encoder.finish(state.completed)
        XCTAssertEqual(encoder.encoded.map(\.seq), [1, 3])
    }
}
