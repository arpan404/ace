import Foundation
import Testing
@testable import Ace

/// Wakes from network changes against the real shared client and a daemon that goes silent.
@Suite(.serialized, .timeLimit(.minutes(1))) @MainActor struct WakeGateTests {
    private func until(_ timeout: Duration, _ done: () -> Bool) async throws -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !done(), clock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return done()
    }

    @Test func aSocketThatDiesAtAChangeInsideAnAnsweredProbesWindowIsStillNoticedInTime() async throws {
        let daemon = try SilentDaemon()
        let port = try await daemon.start()
        defer { daemon.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = ClientModel(now: { Date().timeIntervalSince1970 * 1000 })
        let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:\(port)")), hostId: "host",
                                      deviceId: "device", pin: nil, credential: { #"{"token":"fixture"}"# })
        await model.connect(target: target, directory: root)
        #expect(try await until(.seconds(10)) { model.connection == "ready" })
        let gate = WakeGate(now: { Date().timeIntervalSince1970 * 1000 }, schedule: RouteRetries.sleeping) { model.wake() }

        // t=0: Wi-Fi to cellular. The probe goes out and the daemon answers it at once.
        let answered = daemon.pongs
        gate.request()
        #expect(try await until(.seconds(2)) { daemon.pongs > answered })
        // t≈1: back to Wi-Fi, and the socket on cellular dies without closing. This change falls
        // inside the first probe's window, whose answer came before the socket died.
        try await Task.sleep(for: .seconds(1))
        daemon.silence()
        let changed = ContinuousClock.now
        gate.request()
        #expect(model.connection == "ready")

        // Noticed within the bound, not at the next regular heartbeat about 30 seconds on.
        let bound = Duration.milliseconds(Int(WakeGate.bound))
        let noticed = try await until(bound + .seconds(1)) { model.connection != "ready" }
        #expect(noticed, "a socket that died at the second change still shows ready")
        #expect(ContinuousClock.now - changed <= bound + .seconds(1))
        await model.disconnectAndWait()
    }
}
