import XCTest
import Foundation
import LockedUseCore
import LockedUseGuardianKit
import LockedUseSystem

final class RelockSink: LockedUseLockSink, @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var onLock: (() -> Void)?
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    func requestLock() throws {
        lock.lock(); value += 1; lock.unlock()
        onLock?()
    }
}

/// A guardian reached over a real in-process XPC connection, with a substitute lock sink,
/// clock and owner-exit watcher. Nothing here locks the Mac.
final class GuardianHarness: @unchecked Sendable {
    let sink = RelockSink()
    let listener = NSXPCListener.anonymous()
    var time: UInt64 = 1_000_000_000
    let clock = NSLock()
    var exits: [() -> Void] = []
    lazy var server = LockedUseGuardianServer(listener: listener, requirement: nil, lock: sink,
        now: { [unowned self] in clock.lock(); defer { clock.unlock() }; return time },
        watch: { [unowned self] _, queue, onExit in
            exits.append { queue.async(execute: onExit) }
            return {}
        })
    var connection: NSXPCConnection!

    func start() -> LockedUseGuardianLink {
        server.start()
        connection = NSXPCConnection(listenerEndpoint: listener.endpoint)
        connection.remoteObjectInterface = NSXPCInterface(with: LockedUseGuardianLink.self)
        connection.resume()
        return connection.synchronousRemoteObjectProxyWithErrorHandler { _ in } as! LockedUseGuardianLink
    }

    func advance(_ nanos: UInt64) { clock.lock(); time += nanos; clock.unlock() }

    func scope(user: UInt32 = getuid()) -> Data {
        let scope = try! LockedUseScope(userID: user, sessionID: 100_003, threadID: "t", turnID: "u", attemptID: "attempt")
        return try! JSONEncoder().encode(scope)
    }

    func call(_ body: (@escaping (Bool) -> Void) -> Void) -> Bool {
        var result = false
        body { result = $0 }
        return result
    }
}

final class GuardianServerTests: XCTestCase {
    func testDroppedOwnerLinkRelocksWithoutAnyFurtherOwnerInstruction() {
        let h = GuardianHarness()
        let link = h.start()
        XCTAssertTrue(h.call { link.arm(scope: h.scope(), reply: $0) })
        let relocked = expectation(description: "guardian relocks on its own")
        h.sink.onLock = { relocked.fulfill() }
        h.connection.invalidate()
        wait(for: [relocked], timeout: 5)
        XCTAssertEqual(h.sink.count, 1)
    }

    func testOwnerProcessDeathRelocks() {
        let h = GuardianHarness()
        let link = h.start()
        XCTAssertTrue(h.call { link.arm(scope: h.scope(), reply: $0) })
        let relocked = expectation(description: "guardian relocks after owner exit")
        h.sink.onLock = { relocked.fulfill() }
        XCTAssertEqual(h.exits.count, 1, "Arming watches the kernel-reported owner process")
        h.exits.forEach { $0() }
        wait(for: [relocked], timeout: 5)
        _ = h.server.state
        XCTAssertEqual(h.sink.count, 1)
    }

    func testMissedHeartbeatsRelockWhileTheLinkStaysOpen() {
        let h = GuardianHarness()
        let link = h.start()
        XCTAssertTrue(h.call { link.arm(scope: h.scope(), reply: $0) })
        h.advance(500_000_000)
        XCTAssertTrue(h.call { link.heartbeat(attempt: "attempt", reply: $0) })
        h.advance(900_000_000)
        h.server.tick()
        _ = h.server.state
        XCTAssertEqual(h.sink.count, 0)
        h.advance(200_000_000)
        h.server.tick()
        _ = h.server.state
        XCTAssertEqual(h.sink.count, 1)
        XCTAssertFalse(h.call { link.heartbeat(attempt: "attempt", reply: $0) }, "The owner learns it lost the guardian")
    }

    func testAScopeForAnotherUserCannotArmTheGuardian() {
        let h = GuardianHarness()
        let link = h.start()
        XCTAssertFalse(h.call { link.arm(scope: h.scope(user: getuid() + 1), reply: $0) })
        XCTAssertFalse(h.call { link.arm(scope: Data("{}".utf8), reply: $0) })
        XCTAssertEqual(h.server.state, .idle)
    }

    func testDisarmAfterConfirmedLockLetsTheOwnerDisconnect() {
        let h = GuardianHarness()
        let link = h.start()
        XCTAssertTrue(h.call { link.arm(scope: h.scope(), reply: $0) })
        XCTAssertTrue(h.call { link.disarm(attempt: "attempt", reply: $0) })
        h.connection.invalidate()
        h.advance(5_000_000_000)
        h.server.tick()
        _ = h.server.state
        XCTAssertEqual(h.sink.count, 0)
    }

    func testTheProductionWatcherSeesARealChildProcessExit() throws {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = ["30"]
        try child.run()
        let exited = expectation(description: "exit observed")
        let cancel = lockedUseWatchProcessExit(child.processIdentifier, DispatchQueue(label: "watch")) { exited.fulfill() }
        defer { cancel() }
        child.terminate()
        wait(for: [exited], timeout: 5)

        let late = expectation(description: "an already-dead owner is reported")
        let done = lockedUseWatchProcessExit(child.processIdentifier, DispatchQueue(label: "watch-late")) { late.fulfill() }
        defer { done() }
        wait(for: [late], timeout: 5)
    }
}
