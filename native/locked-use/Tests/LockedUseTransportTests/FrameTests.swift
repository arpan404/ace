import XCTest
import LockedUseTransport

final class FrameTests: XCTestCase {
    func testFramesSplitAcrossReadsAndPackedTogetherBothDecode() throws {
        let a = try lockedUseEncodeFrame(Data("{\"a\":1}".utf8))
        let b = try lockedUseEncodeFrame(Data("{\"b\":2}".utf8))
        var decoder = LockedUseFrameDecoder()
        let stream = a + b
        var frames: [Data] = []
        for byte in stream.prefix(5) { frames += try decoder.append(Data([byte])) }
        frames += try decoder.append(stream.dropFirst(5))
        XCTAssertEqual(frames.map { String(decoding: $0, as: UTF8.self) }, ["{\"a\":1}", "{\"b\":2}"])
    }

    func testAnOversizedLengthIsRejectedBeforeBufferingAndPoisonsTheStream() {
        var decoder = LockedUseFrameDecoder()
        XCTAssertThrowsError(try decoder.append(Data([0, 1, 0, 1]))) { XCTAssertEqual($0 as? LockedUseFrameError, .oversized(65_537)) }
        XCTAssertThrowsError(try decoder.append(try! lockedUseEncodeFrame(Data("{}".utf8)))) {
            XCTAssertEqual($0 as? LockedUseFrameError, .poisoned, "A stream cannot resynchronise after a bad length")
        }
    }

    func testEmptyFramesAreRejected() {
        var decoder = LockedUseFrameDecoder()
        XCTAssertThrowsError(try decoder.append(Data([0, 0, 0, 0])))
        XCTAssertThrowsError(try lockedUseEncodeFrame(Data()))
        XCTAssertThrowsError(try lockedUseEncodeFrame(Data(count: lockedUseMaxFrame + 1)))
        XCTAssertNoThrow(try lockedUseEncodeFrame(Data(count: lockedUseMaxFrame)))
    }
}
