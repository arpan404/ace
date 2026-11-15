import Foundation
import Testing
@testable import Ace

/// Wakes on network changes against the real shared client and a daemon that goes silent. A
/// socket dead at a wake must leave `ready` within `bound` of it: 300 ms for wakes close together
/// to share a ping, then the probe's deadline, 5 s on a link not yet measured (a single route
/// always), plus `margin` for the hops between the client's thread and the main thread.
@Suite(.serialized, .timeLimit(.minutes(1))) @MainActor struct ConnectionLivenessTests {
    private static let bound = Duration.milliseconds(5_300)
    private static let margin = Duration.milliseconds(750)

    private func until(_ timeout: Duration, _ done: () -> Bool) async throws -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !done(), clock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return done()
    }
    private func connected(to daemon: SilentDaemon, root: URL) async throws -> ClientModel {
        let port = try await daemon.start()
        let model = ClientModel(now: { Date().timeIntervalSince1970 * 1000 })
        let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:\(port)")), hostId: "host",
                                      deviceId: "device", pin: nil, credential: { #"{"token":"fixture"}"# })
        await model.connect(target: target, directory: root)
        try #require(try await until(.seconds(10)) { model.connection == "ready" }, "the client never connected")
        return model
    }
    /// Waits for the socket to leave ready, and how long that took from `since`.
    private func noticed(since: ContinuousClock.Instant, _ model: ClientModel) async throws -> Duration? {
        let left = try await until(Self.bound + Self.margin + .seconds(1)) { model.connection != "ready" }
        return left ? ContinuousClock.now - since : nil
    }

    @Test func aSocketThatDiesRightAfterAnAnsweredWakeIsNoticedByTheNextWakeInTime() async throws {
        let daemon = try SilentDaemon()
        defer { daemon.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = try await connected(to: daemon, root: root)

        // t=0: Wi-Fi to cellular. The wake's ping is answered at once.
        let answered = daemon.pongs
        model.wake()
        try #require(try await until(.seconds(2)) { daemon.pongs > answered }, "the first wake was never answered")
        // t=1: back to Wi-Fi, and the socket on cellular dies without closing.
        try await Task.sleep(for: .seconds(1))
        daemon.silence()
        let woke = ContinuousClock.now
        model.wake()

        let took = try await noticed(since: woke, model)
        #expect(took != nil, "a socket that died before the second wake still shows ready")
        if let took { #expect(took <= Self.bound + Self.margin, "noticed after \(took)") }
        await model.disconnectAndWait()
    }

    @Test func pongsStillInTransitWhenTheSocketDiesNeverAnswerTheNextWake() async throws {
        let daemon = try SilentDaemon()
        defer { daemon.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = try await connected(to: daemon, root: root)

        // The regular heartbeat's ping and the first wake's ping are answered, but both pongs
        // are still in transit.
        daemon.hold()
        let before = daemon.pings
        try #require(try await until(.seconds(20)) { daemon.pings > before }, "no regular heartbeat ping")
        model.wake()
        try #require(try await until(.seconds(2)) { daemon.pings > before + 1 }, "the first wake sent no ping")
        // t=1: the interface changes and the socket dies; the next wake's ping goes unanswered.
        try await Task.sleep(for: .seconds(1))
        daemon.silence()
        let woke = ContinuousClock.now
        model.wake()
        try #require(try await until(.seconds(2)) { daemon.pings > before + 2 }, "the second wake sent no ping")
        // The two pongs sent before the socket died arrive after that probe has started.
        daemon.release()

        let took = try await noticed(since: woke, model)
        #expect(took != nil, "a late pong from before the socket died kept it showing ready")
        if let took { #expect(took <= Self.bound + Self.margin, "noticed after \(took)") }
        await model.disconnectAndWait()
    }
}
