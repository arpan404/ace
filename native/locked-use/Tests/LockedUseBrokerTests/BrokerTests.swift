import XCTest
import Foundation
import Darwin
import LockedUseBrokerKit
import LockedUseIPC

/// Stands in for the GUI coordinator on the far side of a real XPC connection.
final class FakeCoordinator: NSObject, LockedUseAuthorizing, @unchecked Sendable {
    var allow = true
    var delay: TimeInterval = 0
    var seen: [String] = []
    func authorize(attempt: String, transaction: Data, request: String, deadline: UInt64, reply: @escaping (Bool) -> Void) {
        seen.append(attempt)
        let answer = allow
        if delay > 0 { DispatchQueue.global().asyncAfter(deadline: .now() + delay) { reply(answer) } }
        else { reply(answer) }
    }
}

/// Real monotonic time plus a skip the test controls, read from any queue.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var skipped: UInt64 = 0
    var now: UInt64 { lock.lock(); defer { lock.unlock() }; return clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) + skipped }
    func skip(_ nanoseconds: UInt64) { lock.lock(); skipped += nanoseconds; lock.unlock() }
}

final class BrokerTests: XCTestCase {
    let clock = TestClock()
    var now: () -> UInt64 { { [clock] in clock.now } }
    let window: UInt64 = 90_000_000_000

    /// `trustedParentOf` stands in for the ancestry check: it gets the registering pid.
    func makeBroker(trustedParentOf: @escaping (Int32) -> Bool = { _ in true }) -> (LockedUseAuthorityBroker, NSXPCListener) {
        let listener = NSXPCListener.anonymous()
        let broker = LockedUseAuthorityBroker(listener: listener, requirement: nil, now: now, attemptWindow: window,
            vetAncestry: trustedParentOf)
        broker.start()
        return (broker, listener)
    }

    func link(_ listener: NSXPCListener, coordinator: FakeCoordinator, register: Bool = true, expect: Bool = true) -> NSXPCConnection {
        let connection = NSXPCConnection(listenerEndpoint: listener.endpoint)
        connection.remoteObjectInterface = NSXPCInterface(with: LockedUseBrokerRegistration.self)
        connection.exportedInterface = NSXPCInterface(with: LockedUseAuthorizing.self)
        connection.exportedObject = coordinator
        connection.resume()
        if register { XCTAssertEqual(self.register(connection), expect) }
        return connection
    }

    func register(_ connection: NSXPCConnection) -> Bool {
        let proxy = connection.synchronousRemoteObjectProxyWithErrorHandler { _ in } as! LockedUseBrokerRegistration
        var ok = false
        proxy.register { ok = $0 }
        return ok
    }

    func waitUnlinked(_ broker: LockedUseAuthorityBroker) {
        let deadline = Date().addingTimeInterval(5)
        while broker.linked, Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        XCTAssertFalse(broker.linked)
    }

    func request(budget: UInt64 = 500_000_000) -> LockedUsePluginRequest {
        LockedUsePluginRequest(attempt: "attempt", transaction: Data(repeating: 1, count: 8), requestID: UUID(), deadline: now() + budget)
    }

    func testNoRegisteredCoordinatorDenies() {
        let (broker, listener) = makeBroker()
        defer { broker.stop() }
        XCTAssertFalse(broker.forward(request()))
        let unregistered = link(listener, coordinator: FakeCoordinator(), register: false)
        defer { unregistered.invalidate() }
        XCTAssertFalse(broker.forward(request()), "Connecting without registering is not a coordinator")
    }

    func testTheRegisteredCoordinatorDecides() {
        let (broker, listener) = makeBroker()
        defer { broker.stop() }
        let coordinator = FakeCoordinator()
        let connection = link(listener, coordinator: coordinator)
        defer { connection.invalidate() }
        XCTAssertTrue(broker.forward(request()))
        coordinator.allow = false
        XCTAssertFalse(broker.forward(request()))
        XCTAssertEqual(coordinator.seen, ["attempt", "attempt"])
    }

    func testALateCoordinatorAnswerIsADenial() {
        let (broker, listener) = makeBroker()
        defer { broker.stop() }
        let coordinator = FakeCoordinator()
        coordinator.delay = 0.4
        let connection = link(listener, coordinator: coordinator)
        defer { connection.invalidate() }
        XCTAssertFalse(broker.forward(request(budget: 100_000_000)))
    }

    func testADroppedCoordinatorLinkDenies() {
        let (broker, listener) = makeBroker()
        defer { broker.stop() }
        let connection = link(listener, coordinator: FakeCoordinator())
        XCTAssertTrue(broker.linked)
        connection.invalidate()
        waitUnlinked(broker)
        XCTAssertFalse(broker.forward(request()))
    }

    func testASecondCoordinatorIsRefusedWhileTheFirstIsLinkedAndNeverAnswersThePlugIn() {
        let (broker, listener) = makeBroker()
        defer { broker.stop() }
        let first = FakeCoordinator()
        let firstLink = link(listener, coordinator: first)
        defer { firstLink.invalidate() }
        let intruder = FakeCoordinator()
        let intruderLink = link(listener, coordinator: intruder, expect: false)
        defer { intruderLink.invalidate() }
        first.allow = false
        XCTAssertFalse(broker.forward(request()), "The bound coordinator still decides")
        XCTAssertEqual(first.seen, ["attempt"])
        XCTAssertEqual(intruder.seen, [], "A refused registration is never consulted")
    }

    func testNobodyMayRegisterWhileAGrantedAttemptMayStillBeLiveEvenAfterItsCoordinatorDies() {
        let (broker, listener) = makeBroker()
        defer { broker.stop() }
        let first = link(listener, coordinator: FakeCoordinator())
        XCTAssertTrue(broker.forward(request()), "A permit was granted: an attempt is live")
        // Killing the coordinator mid-attempt must not hand the plug-in to a newcomer.
        first.invalidate()
        waitUnlinked(broker)
        let intruder = FakeCoordinator()
        let early = link(listener, coordinator: intruder, expect: false)
        defer { early.invalidate() }
        XCTAssertFalse(broker.forward(request()))
        XCTAssertEqual(intruder.seen, [])
        clock.skip(window - 1_000_000_000)
        XCTAssertFalse(register(early), "Still inside the attempt window")
        clock.skip(2_000_000_000)
        let later = FakeCoordinator()
        let laterLink = link(listener, coordinator: later)
        defer { laterLink.invalidate() }
        XCTAssertTrue(broker.forward(request()), "Once no attempt can be live, a restarted coordinator links")
        XCTAssertEqual(later.seen, ["attempt"])
    }

    func testARestartedCoordinatorLinksOnceTheOldLinkIsGoneWhenNothingWasGranted() {
        let (broker, listener) = makeBroker()
        defer { broker.stop() }
        let old = FakeCoordinator()
        old.allow = false
        let oldLink = link(listener, coordinator: old)
        XCTAssertFalse(broker.forward(request()))
        oldLink.invalidate()
        waitUnlinked(broker)
        let next = link(listener, coordinator: FakeCoordinator())
        defer { next.invalidate() }
        XCTAssertTrue(broker.forward(request()))
    }

    func testACoordinatorNotSpawnedByTheTrustedDaemonIsRefused() {
        let foreign = makeBroker(trustedParentOf: { $0 == getpid() &+ 1 })
        defer { foreign.0.stop() }
        let impostor = FakeCoordinator()
        let impostorLink = link(foreign.1, coordinator: impostor, expect: false)
        defer { impostorLink.invalidate() }
        XCTAssertFalse(foreign.0.linked)
        XCTAssertFalse(foreign.0.forward(request()))
        XCTAssertEqual(impostor.seen, [])
        // The same process, vetted as the trusted daemon's child, is accepted.
        let trusted = makeBroker(trustedParentOf: { $0 == getpid() })
        defer { trusted.0.stop() }
        let ownLink = link(trusted.1, coordinator: FakeCoordinator())
        defer { ownLink.invalidate() }
        XCTAssertTrue(trusted.0.forward(request()))
    }
}
