import XCTest
import LockedUseBrokerKit
import LockedUseCore
import LockedUseGuardianKit
import LockedUseService
import LockedUseSystem

/// A guardian or broker that answers only when the test releases it.
final class SlowPeer: NSObject, NSXPCListenerDelegate, LockedUseGuardianLink, LockedUseBrokerRegistration, @unchecked Sendable {
    let listener = NSXPCListener.anonymous()
    let release = DispatchSemaphore(value: 0)
    let interface: Protocol

    init(_ interface: Protocol) {
        self.interface = interface
        super.init()
        listener.delegate = self
        listener.resume()
    }

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        connection.exportedInterface = NSXPCInterface(with: interface)
        connection.exportedObject = self
        connection.resume()
        return true
    }

    func answer(_ reply: @escaping (Bool) -> Void) {
        DispatchQueue.global().async { [release] in
            release.wait()
            reply(true)
        }
    }

    func ping(reply: @escaping (Bool) -> Void) { answer(reply) }
    func register(reply: @escaping (Bool) -> Void) { answer(reply) }
    func arm(scope: Data, reply: @escaping (Bool) -> Void) { reply(false) }
    func heartbeat(attempt: String, reply: @escaping (Bool) -> Void) { reply(false) }
    func disarm(attempt: String, reply: @escaping (Bool) -> Void) { reply(false) }
}

@MainActor final class Ticks { var count = 0 }

@MainActor final class MainThreadTests: XCTestCase {
    /// The production heartbeat is a 50 ms main-run-loop timer; this one counts how often
    /// it gets to run over 200 ms, while something slow started just before is pending.
    func heartbeats() async -> Int {
        let ticks = Ticks()
        let timer = Timer(timeInterval: 0.01, repeats: true) { _ in MainActor.assumeIsolated { ticks.count += 1 } }
        RunLoop.main.add(timer, forMode: .common)
        try? await Task.sleep(nanoseconds: 200_000_000)
        timer.invalidate()
        return ticks.count
    }

    func testASlowInstallationProbeDoesNotStopTheHeartbeat() async {
        let gate = DispatchSemaphore(value: 0)
        let monitor = LockedUseInstallationMonitor(queue: DispatchQueue(label: "probe")) {
            gate.wait()
            return LockedUseInstallationFacts(pluginSigned: true, ruleReachesMechanism: true, lockOnDisplaySleep: true)
        }
        let done = expectation(description: "probe finished")
        monitor.refresh { done.fulfill() }
        let ticks = await heartbeats()
        XCTAssertGreaterThanOrEqual(ticks, 5, "The main thread kept running while the probe was blocked")
        XCTAssertFalse(monitor.facts.pluginSigned, "Nothing is assumed before the probe answers")
        gate.signal()
        await fulfillment(of: [done], timeout: 5)
        XCTAssertTrue(monitor.facts.pluginSigned && monitor.facts.ruleReachesMechanism && monitor.facts.lockOnDisplaySleep)
    }

    func testASlowGuardianPingDoesNotStopTheHeartbeat() async {
        let peer = SlowPeer(LockedUseGuardianLink.self)
        let client = LockedUseGuardianClient(connect: { NSXPCConnection(listenerEndpoint: peer.listener.endpoint) }, now: { 0 })
        var answers: [Bool] = []
        client.ping { answers.append($0) }
        let ticks = await heartbeats()
        XCTAssertGreaterThanOrEqual(ticks, 5, "The ping did not hold the main thread")
        XCTAssertEqual(answers, [], "Still waiting on the guardian")
        peer.release.signal()
        try? await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertEqual(answers.count, 1, "Exactly one answer, from the reply or the timeout")
    }

    func testAGuardianThatNeverAnswersReadsAsNotLinked() async {
        let peer = SlowPeer(LockedUseGuardianLink.self)
        let client = LockedUseGuardianClient(connect: { NSXPCConnection(listenerEndpoint: peer.listener.endpoint) }, now: { 0 })
        let answered = expectation(description: "timed out")
        var answer: Bool?
        client.ping { answer = $0; answered.fulfill() }
        await fulfillment(of: [answered], timeout: 5)
        XCTAssertEqual(answer, false)
        peer.release.signal()
    }

    func testASlowBrokerRegistrationDoesNotStopTheHeartbeat() async throws {
        let peer = SlowPeer(LockedUseBrokerRegistration.self)
        let coordinator = ServiceFixture().service.coordinator
        let broker = LockedUseBrokerClient(connect: { NSXPCConnection(listenerEndpoint: peer.listener.endpoint) }, coordinator: coordinator)
        let registered = expectation(description: "registered")
        broker.register { _ in registered.fulfill() }
        let ticks = await heartbeats()
        XCTAssertGreaterThanOrEqual(ticks, 5)
        XCTAssertFalse(broker.linked, "Not linked until the broker accepts")
        peer.release.signal()
        await fulfillment(of: [registered], timeout: 5)
        XCTAssertTrue(broker.linked)
    }
}
