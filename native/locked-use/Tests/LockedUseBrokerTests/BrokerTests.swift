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

final class BrokerTests: XCTestCase {
    let now: () -> UInt64 = { clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) }

    func makeBroker() -> (LockedUseAuthorityBroker, NSXPCListener) {
        let listener = NSXPCListener.anonymous()
        let broker = LockedUseAuthorityBroker(listener: listener, requirement: nil, now: now)
        broker.start()
        return (broker, listener)
    }

    func link(_ listener: NSXPCListener, coordinator: FakeCoordinator, register: Bool = true) -> NSXPCConnection {
        let connection = NSXPCConnection(listenerEndpoint: listener.endpoint)
        connection.remoteObjectInterface = NSXPCInterface(with: LockedUseBrokerRegistration.self)
        connection.exportedInterface = NSXPCInterface(with: LockedUseAuthorizing.self)
        connection.exportedObject = coordinator
        connection.resume()
        if register {
            let proxy = connection.synchronousRemoteObjectProxyWithErrorHandler { _ in } as! LockedUseBrokerRegistration
            var ok = false
            proxy.register { ok = $0 }
            XCTAssertTrue(ok)
        }
        return connection
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
        let deadline = Date().addingTimeInterval(5)
        while broker.linked, Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
        XCTAssertFalse(broker.linked)
        XCTAssertFalse(broker.forward(request()))
    }
}
