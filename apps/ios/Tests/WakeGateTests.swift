import Foundation
import os
import Testing
@testable import Ace

/// The gate's own time: a manual clock and the work scheduled against it.
@MainActor private final class GateTime {
    private(set) var now: Double = 100_000
    private var jobs: [(id: Int, at: Double, work: @MainActor () -> Void)] = []
    private var issued = 0
    let cancelled = OSAllocatedUnfairLock<Set<Int>>(initialState: [])
    /// Jobs neither run nor cancelled.
    var pending: Int { let gone = cancelled.withLock { $0 }; return jobs.filter { !gone.contains($0.id) }.count }
    /// When the next job still waiting is due.
    var nextAt: Double? { let gone = cancelled.withLock { $0 }; return jobs.filter { !gone.contains($0.id) }.map(\.at).min() }
    func schedule(_ delay: Double, _ work: @escaping @MainActor () -> Void) -> @Sendable () -> Void {
        issued += 1
        let id = issued
        jobs.append((id, now + delay, work))
        let cancelled = cancelled
        return { cancelled.withLock { _ = $0.insert(id) } }
    }
    func advance(_ ms: Double) {
        now += ms
        let gone = cancelled.withLock { $0 }
        let due = jobs.filter { $0.at <= now }
        jobs.removeAll { $0.at <= now }
        for job in due where !gone.contains(job.id) { job.work() }
    }
}

@Suite @MainActor struct WakeGateTests {
    private func gate(_ time: GateTime, wakes: @escaping @MainActor () -> Void) -> WakeGate {
        WakeGate(now: { [time] in MainActor.assumeIsolated { time.now } }, schedule: { time.schedule($0, $1) }, wake: wakes)
    }

    @Test func aChangeInsideTheWindowGetsOneTrailingWakeJustAfterTheWindow() {
        let time = GateTime()
        var wakes = 0
        let gate = gate(time) { wakes += 1 }
        gate.request()
        time.advance(1_000)
        gate.request()
        time.advance(1_000)
        gate.request()
        #expect(wakes == 1)
        #expect(time.pending == 1, "every change in the window shares one trailing wake")
        #expect(time.nextAt == 100_000 + WakeGate.probeWindow + WakeGate.settle)
        time.advance(WakeGate.probeWindow + WakeGate.settle - 2_000 - 1)
        #expect(wakes == 1)
        time.advance(1)
        #expect(wakes == 2)
        #expect(time.pending == 0)
    }
    @Test func aChangeExactlyAtTheWindowsEndWakesAtOnceAndCancelsTheTrailingWake() {
        let time = GateTime()
        var wakes = 0
        let gate = gate(time) { wakes += 1 }
        gate.request()
        time.advance(1_000)
        gate.request()
        #expect(time.pending == 1)
        time.advance(WakeGate.probeWindow - 1_000)
        gate.request()
        #expect(wakes == 2)
        #expect(time.pending == 0, "the new window's wake answers the change that was waiting")
        time.advance(WakeGate.bound)
        #expect(wakes == 2)
    }
    @Test func aGateThatGoesAwayCancelsItsTrailingWake() {
        let time = GateTime()
        var wakes = 0
        var gate: WakeGate? = gate(time) { wakes += 1 }
        gate?.request()
        time.advance(1_000)
        gate?.request()
        #expect(time.pending == 1)
        gate = nil
        #expect(time.pending == 0)
        time.advance(WakeGate.bound)
        #expect(wakes == 1)
    }
    @Test func cancellingDropsTheTrailingWake() {
        let time = GateTime()
        var wakes = 0
        let gate = gate(time) { wakes += 1 }
        gate.request()
        time.advance(1_000)
        gate.request()
        gate.cancel()
        #expect(time.pending == 0)
        time.advance(WakeGate.bound)
        #expect(wakes == 1)
    }
    @Test func theAppsSchedulerNeverRunsCancelledWork() async throws {
        var ran = false
        let cancel = WakeGate.sleeping(50) { ran = true }
        cancel()
        try await Task.sleep(for: .milliseconds(200))
        #expect(!ran)
        var ranLater = false
        _ = WakeGate.sleeping(20) { ranLater = true }
        try await Task.sleep(for: .milliseconds(200))
        #expect(ranLater)
    }
}

/// The scenario against the real shared client and a daemon that goes silent. The gate runs on
/// its own manual time; only the socket's liveness runs in real time, the client's 5 s probe,
/// allowed `margin` on top for the hops between the client's thread and the main thread.
@Suite(.serialized, .timeLimit(.minutes(1))) @MainActor struct WakeGateLivenessTests {
    private static let margin = Duration.milliseconds(750)
    private func until(_ timeout: Duration, _ done: () -> Bool) async throws -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !done(), clock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return done()
    }

    @Test func aSocketThatDiesAtAChangeInsideAnAnsweredProbesWindowIsNoticedByTheTrailingProbe() async throws {
        let daemon = try SilentDaemon()
        let port = try await daemon.start()
        defer { daemon.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = ClientModel(now: { Date().timeIntervalSince1970 * 1000 })
        let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:\(port)")), hostId: "host",
                                      deviceId: "device", pin: nil, credential: { #"{"token":"fixture"}"# })
        await model.connect(target: target, directory: root)
        try #require(try await until(.seconds(10)) { model.connection == "ready" }, "the client never connected")
        let time = GateTime()
        let gate = WakeGate(now: { [time] in MainActor.assumeIsolated { time.now } }, schedule: { time.schedule($0, $1) }) { model.wake() }

        // t=0: Wi-Fi to cellular. The probe goes out and the daemon answers it at once.
        let answered = daemon.pongs
        let probed = ContinuousClock.now
        gate.request()
        try #require(try await until(.seconds(2)) { daemon.pongs > answered }, "the first probe was never answered")
        // t=1: back to Wi-Fi, and the socket on cellular dies without closing. The change falls
        // inside the first probe's window, whose answer came before the socket died.
        time.advance(1_000)
        daemon.silence()
        gate.request()
        #expect(time.nextAt == time.now + WakeGate.probeWindow - 1_000 + WakeGate.settle)
        // The first probe settles in real time; the gate's trailing wake goes out after it.
        try await Task.sleep(until: probed + .milliseconds(Int(WakeGate.probeWindow + WakeGate.settle)), clock: .continuous)
        try #require(model.connection == "ready", "the answered probe must not have failed the socket")
        time.advance(WakeGate.probeWindow - 1_000 + WakeGate.settle)
        let trailing = ContinuousClock.now

        // Noticed by the trailing probe's own window, not at the next heartbeat about 30 s on.
        let window = Duration.milliseconds(Int(WakeGate.probeWindow))
        let noticed = try await until(window + Self.margin) { model.connection != "ready" }
        #expect(noticed, "a socket that died at the second change still shows ready")
        #expect(ContinuousClock.now - trailing <= window + Self.margin)
        await model.disconnectAndWait()
    }
}
