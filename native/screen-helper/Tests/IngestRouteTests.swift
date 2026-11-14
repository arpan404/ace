import XCTest
import Darwin
@testable import ScreenHelper

/// The route as Capture and `--encode-frames` own it: the test never holds a writer.
final class IngestRouteTests: XCTestCase {
    private let token = Data(repeating: 7, count: 32)

    private func unit(_ sequence: UInt64, bytes: Int, keyframe: Bool = false) -> EncodedVideo {
        var payload = Data(repeating: UInt8(sequence & 0xff), count: bytes)
        payload.replaceSubrange(0..<5, with: [0, 0, 0, 1, keyframe ? 0x65 : 0x41])
        return EncodedVideo(keyframe: keyframe, codec: keyframe ? "avc1.640033" : nil, width: 64, height: 64, scale: 1,
            sequence: sequence, timestamp: Double(sequence), epoch: 0, capturedAt: 0, payloadBytes: payload.count,
            packet: { header in header + payload })
    }

    private func route() -> IngestRoute { IngestRoute(legacy: { _ in }, now: { 0 }) }

    func testUnitsQueuedBehindABlockedReaderStillReachItAfterTheRouteMovesOn() throws {
        let listener = try Listener()
        let route = route()
        _ = try route.route(to: (listener.path, token))
        listener.accept()
        // ace-media isn't reading: these stay queued in the writer.
        let units = (1...3).map { unit(UInt64($0), bytes: 1 << 20, keyframe: $0 == 1) }
        for unit in units { route.publish(unit) }
        XCTAssertEqual(try route.route(to: nil).boundary, 3)
        // Only now does ace-media catch up: every queued unit arrives, then a clean close.
        let (received, ended) = listener.readToEnd()
        XCTAssertTrue(ended)
        var expected = 44 + 32
        for unit in units { expected += 44 + 28 + unit.payloadBytes + (unit.keyframe ? 11 : 0) }
        XCTAssertEqual(received.count, expected, "the replaced writer drained before it closed")
    }

    func testAReplacedWriterThatFailsLeavesItsSuccessorAlone() throws {
        let first = try Listener(), second = try Listener()
        let route = route()
        var failures: [UInt64?] = []
        route.onClosed = { failures.append($0) }
        _ = try route.route(to: (first.path, token))
        first.accept()
        // A backlog on the first connection, so it is still writing after the switch.
        for sequence in 1...3 { route.publish(unit(UInt64(sequence), bytes: 1 << 20, keyframe: sequence == 1)) }
        _ = try route.route(to: (second.path, Data(repeating: 8, count: 32)))
        second.accept()
        // ace-media drops the first connection while it still drains: that writer fails.
        first.drop()
        usleep(200_000)
        XCTAssertTrue(failures.isEmpty, "a replaced writer's failure is not the route's")
        XCTAssertTrue(route.ingesting)
        route.publish(unit(4, bytes: 100, keyframe: true))
        let hello = second.read(44 + 32)
        XCTAssertEqual(hello.count, 44 + 32)
        XCTAssertEqual(second.read(44 + 11 + 28 + 100).count, 44 + 11 + 28 + 100, "the successor still carries video")
        route.close()
    }

    func testAReplacedWriterThatNeverDrainsIsClosedAfterTheLimit() throws {
        let listener = try Listener()
        let route = IngestRoute(legacy: { _ in }, now: { 0 }, drainLimit: 0.2)
        _ = try route.route(to: (listener.path, token))
        listener.accept()
        for sequence in 1...3 { route.publish(unit(UInt64(sequence), bytes: 1 << 20, keyframe: sequence == 1)) }
        _ = try route.route(to: nil)
        XCTAssertEqual(route.retiring, 1)
        usleep(500_000)
        XCTAssertEqual(route.retiring, 0, "released once the limit passed")
        // ace-media sees the connection end without the queued units: the path was cut.
        let (received, ended) = listener.readToEnd()
        XCTAssertTrue(ended)
        XCTAssertLessThan(received.count, 3 << 20)
    }
}
