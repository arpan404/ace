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

    private func route() -> IngestRoute { IngestRoute(now: { 0 }) }

    func testWithoutAnIngestVideoGoesNowhereAndNoBoundaryIsClaimed() throws {
        let listener = try Listener()
        let route = route()
        defer { route.close() }
        // No ingest yet: these units have no path at all, so none is a boundary.
        route.publish(unit(1, bytes: 100, keyframe: true))
        route.publish(unit(2, bytes: 100))
        let moved = try route.route(to: (listener.path, token))
        listener.accept()
        XCTAssertEqual(moved.switched, true)
        XCTAssertNil(moved.boundary, "nothing went anywhere before the first ingest")
        route.publish(unit(3, bytes: 100, keyframe: true))
        XCTAssertEqual(listener.read(44 + 32).count, 44 + 32, "the hello")
        XCTAssertEqual(listener.read(44 + 11 + 28 + 100).count, 44 + 11 + 28 + 100, "only the unit after the switch")
    }

    func testSubmittedOutputStaysOnTheOldIngestBeforeAPlannedSwitch() throws {
        let first = try Listener(), second = try Listener()
        var completing = false
        var route: IngestRoute!
        // Completing an outstanding hardware encode publishes its delta synchronously.
        route = IngestRoute(now: { 0 }, beforeSwitch: { if completing { route.publish(self.unit(2, bytes: 100)) } })
        defer { route.close(); route = nil }
        _ = try route.route(to: (first.path, token))
        first.accept()
        route.publish(unit(1, bytes: 100, keyframe: true))
        completing = true
        let moved = try route.route(to: (second.path, Data(repeating: 8, count: 32)))
        second.accept()
        XCTAssertEqual(moved.boundary, 2, "the submitted delta completes on the old ingest")
        let (received, ended) = first.readToEnd()
        XCTAssertTrue(ended)
        XCTAssertEqual(received.count, 44 + 32 + (44 + 11 + 28 + 100) + (44 + 28 + 100) + 44)
    }

    func testFailureWaitsForTheEncoderOwnerBeforeChangingTheRoute() throws {
        let listener = try Listener()
        var recovery: (() -> Void)?
        var drain: () -> Void = {}
        let notified = expectation(description: "failure queued on encoder owner")
        let closed = expectation(description: "stop reported")
        var boundary: UInt64?
        let route = IngestRoute(now: { 0 }, beforeSwitch: { drain() }, recover: { work in recovery = work; notified.fulfill() })
        defer { route.close() }
        route.onClosed = { boundary = $0; closed.fulfill() }
        _ = try route.route(to: (listener.path, token))
        listener.accept()
        route.publish(unit(1, bytes: 100, keyframe: true))
        listener.drop()
        wait(for: [notified], timeout: 5)
        // Drain the in-flight delta while the failed route still owns it: it is the failed
        // writer's, so the boundary the daemon hears is still the last unit that writer took.
        var submitted: (() -> Void)? = { route.publish(self.unit(2, bytes: 100)) }
        drain = { submitted?(); submitted = nil }
        recovery?()
        submitted?()
        wait(for: [closed], timeout: 5)
        XCTAssertFalse(route.ingesting, "video goes nowhere until a new ingest is given")
        XCTAssertNotNil(boundary)
    }

    func testAStillAfterTheLastVideoUnitNeverBecomesTheSwitchBoundary() throws {
        let first = try Listener(), second = try Listener()
        let route = route()
        _ = try route.route(to: (first.path, token))
        first.accept()
        route.publish(unit(1, bytes: 100, keyframe: true))
        route.publish(unit(2, bytes: 100))
        // A still goes out on the daemon's socket after the last video unit, numbered after it.
        var stills = 0
        route.still { stills += 1 }
        let moved = try route.route(to: (second.path, Data(repeating: 8, count: 32)))
        second.accept()
        XCTAssertEqual(stills, 1)
        // The daemon compares the boundary with video sequences: a still's would never arrive,
        // and the switch would wait out its limit and end interrupted.
        XCTAssertEqual(moved.switched, true)
        XCTAssertEqual(moved.boundary, 2, "the boundary is the last video unit the old ingest took")
        route.close()
    }

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
        XCTAssertEqual(received.count, expected + 44, "the replaced writer drained before it closed")
        XCTAssertTrue(isEndFrame(received.suffix(44)), "a planned switch is a clean end: nothing lost")
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
        let route = IngestRoute(now: { 0 }, drainLimit: 0.2)
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
        XCTAssertFalse(isEndFrame(received.suffix(44)), "a writer closed at the limit ends interrupted")
    }

    /// Timers the test fires itself.
    private final class Timers {
        var scheduled: [(work: () -> Void, cancelled: Bool)] = []
        func schedule(_ delay: TimeInterval, _ work: @escaping () -> Void) -> () -> Void {
            let index = scheduled.count
            scheduled.append((work, false))
            return { [weak self] in self?.scheduled[index].cancelled = true }
        }
    }

    func testAWriterAceMediaClosedBeforeItWasInstalledStopsVideo() throws {
        let listener = try Listener()
        let route = IngestRoute(now: { 0 }, connect: { socket, token, onClosed, onKeyframe in
            let writer = try IngestWriter(path: socket, token: token, onClosed: onClosed, onKeyframe: onKeyframe)
            // ace-media refuses the connection before the route has installed the writer.
            listener.accept(); listener.drop()
            XCTAssertTrue(waitFor { writer.isClosed })
            usleep(50_000)
            return writer
        })
        let moved = try route.route(to: (listener.path, token))
        XCTAssertTrue(moved.switched)
        XCTAssertFalse(route.ingesting, "a writer closed at installation is a failure: video goes nowhere")
    }

    func testADrainedWritersTimerIsCancelled() throws {
        let listener = try Listener()
        let timers = Timers()
        let route = IngestRoute(now: { 0 }, schedule: timers.schedule)
        _ = try route.route(to: (listener.path, token))
        listener.accept()
        _ = try route.route(to: nil)
        _ = listener.readToEnd()
        XCTAssertTrue(waitFor { route.retiring == 0 })
        XCTAssertEqual(timers.scheduled.count, 1)
        XCTAssertTrue(waitFor { timers.scheduled[0].cancelled }, "the drain finished, so its limit is cancelled")
    }

    func testAStaleTimerNeverClosesALaterWriterAtTheSameAddress() throws {
        let timers = Timers()
        // Each writer's address as the route made it, without keeping the writer alive.
        var made: [ObjectIdentifier] = []
        let route = IngestRoute(now: { 0 }, connect: { socket, token, onClosed, onKeyframe in
            let writer = try IngestWriter(path: socket, token: token, onClosed: onClosed, onKeyframe: onKeyframe)
            made.append(ObjectIdentifier(writer))
            return writer
        }, schedule: timers.schedule)
        let first = try Listener()
        _ = try route.route(to: (first.path, token))
        first.accept()
        _ = try route.route(to: nil)
        _ = first.readToEnd()
        XCTAssertTrue(waitFor { route.retiring == 0 })
        let freed = made[0]
        // Flip until a new writer takes the freed one's address, as the allocator tends to.
        var listeners: [Listener] = []
        var reused = false
        for attempt in 0..<64 {
            let listener = try Listener()
            listeners.append(listener)
            _ = try route.route(to: (listener.path, Data(repeating: UInt8(attempt + 9), count: 32)))
            listener.accept()
            if made.last == freed { reused = true; break }
            _ = try route.route(to: nil)
            _ = listener.readToEnd()
            XCTAssertTrue(waitFor { route.retiring == 0 })
        }
        guard reused, let second = listeners.last else { throw XCTSkip("no writer reused the freed address in 64 tries") }
        // The writer at the reused address retires with a backlog while the first one's timer is
        // still pending.
        for sequence in 1...3 { route.publish(unit(UInt64(sequence), bytes: 1 << 20, keyframe: sequence == 1)) }
        _ = try route.route(to: nil)
        XCTAssertEqual(route.retiring, 1)
        timers.scheduled[0].work()
        XCTAssertEqual(route.retiring, 1, "the first retirement's timer is not the second's, whatever their addresses")
        let (received, ended) = second.readToEnd()
        XCTAssertTrue(ended)
        XCTAssertGreaterThan(received.count, 3 << 20, "the second writer drained in full")
    }

    func testATimerThatFiresBeforeItsRetirementIsRecordedStillEndsIt() throws {
        let listener = try Listener()
        // The limit passes at once: the timer fires inside `schedule`, before it returns.
        let route = IngestRoute(now: { 0 }, drainLimit: 0, schedule: { _, work in work(); return {} })
        _ = try route.route(to: (listener.path, token))
        listener.accept()
        // ace-media isn't reading, so the writer can't drain on its own.
        for sequence in 1...3 { route.publish(unit(UInt64(sequence), bytes: 1 << 20, keyframe: sequence == 1)) }
        _ = try route.route(to: nil)
        XCTAssertEqual(route.retiring, 0, "the limit closed it: nothing is left without a deadline")
        let (received, ended) = listener.readToEnd()
        XCTAssertTrue(ended)
        XCTAssertLessThan(received.count, 3 << 20)
    }

    func testRetiredWritersHoldingMoreThanTheByteLimitLoseTheOldest() throws {
        let route = IngestRoute(now: { 0 }, schedule: { _, _ in {} })
        var listeners: [Listener] = []
        // Three blocked writers each holding two 3.5 MiB keyframes (a writer drops deltas past its
        // own bound, never keyframes): about 21 MiB, past 16 MiB, under four writers. Closing the
        // oldest brings the rest under the limit.
        for index in 0..<3 {
            let listener = try Listener()
            _ = try route.route(to: (listener.path, Data(repeating: UInt8(index + 1), count: 32)))
            listener.accept()
            listeners.append(listener)
            for sequence in 1...2 { route.publish(unit(UInt64(sequence), bytes: 7 << 19, keyframe: true)) }
        }
        _ = try route.route(to: nil)
        XCTAssertEqual(route.retiring, 2, "the oldest retired writer is closed past the byte limit")
        let (received, ended) = listeners[0].readToEnd()
        XCTAssertTrue(ended)
        XCTAssertLessThan(received.count, 8 << 20)
        route.close()
    }

    func testRapidFlipsKeepAtMostFourRetiredWritersClosingTheOldest() throws {
        let route = IngestRoute(now: { 0 }, schedule: { _, _ in {} })
        var listeners: [Listener] = []
        for index in 0..<5 {
            let listener = try Listener()
            _ = try route.route(to: (listener.path, Data(repeating: UInt8(index + 1), count: 32)))
            listener.accept()
            listeners.append(listener)
            // ace-media isn't reading: each connection keeps a backlog.
            for sequence in 1...2 { route.publish(unit(UInt64(sequence), bytes: 1 << 20, keyframe: sequence == 1)) }
        }
        _ = try route.route(to: nil)
        XCTAssertEqual(route.retiring, 4, "the oldest retired writer is closed past the cap")
        // The oldest connection ends without its backlog: that path was cut.
        let (received, ended) = listeners[0].readToEnd()
        XCTAssertTrue(ended)
        XCTAssertLessThan(received.count, 2 << 20)
        route.close()
    }
}
