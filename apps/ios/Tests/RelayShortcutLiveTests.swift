import Foundation
import Testing
@testable import Ace

/// The relay socket's first handshake message (ADR 0155 steps 1 and 3) against the real Node
/// relay, through the fixture's proxies standing in for relays of each generation
/// (`scripts/relay-fixture.ts`, `scripts/relay-proxy.ts`). Each proxy's log says what the phone
/// offered, what the relay echoed and which way the first frames went. Serialized: the logs are
/// read by position. Runs when the fixture's JSON is passed as `TEST_RUNNER_ACE_RELAY_FIXTURE`.
@Suite(.serialized, .timeLimit(.minutes(1))) struct RelayShortcutLiveTests {
    private struct Relay: Decodable { let url: URL; let log: URL }
    private struct Fixture: Decodable { let hostId: String; let relays: [String: Relay] }
    private struct Record: Decodable { let offered: [String]; let echoed: String; let refused: Bool; let order: [String]; let closed: Int? }
    private static let fixture: Fixture? = ProcessInfo.processInfo.environment["ACE_RELAY_FIXTURE"]
        .flatMap { try? JSONDecoder().decode(Fixture.self, from: Data($0.utf8)) }

    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var events: [(String, SocketPayload)] = []
        func add(_ type: String, _ value: SocketPayload) { lock.withLock { events.append((type, value)) } }
        var texts: [String] { lock.withLock { events.compactMap { if $0.0 == "message", case .text(let t) = $0.1 { t } else { nil } } } }
        var types: [String] { lock.withLock { events.map(\.0) } }
        func wait(_ done: @escaping (Recorder) -> Bool) async throws {
            for _ in 0..<500 where !done(self) { try await Task.sleep(for: .milliseconds(20)) }
            #expect(done(self), "events: \(types)")
        }
    }

    private func relay(_ name: String) throws -> (Relay, String) {
        let fixture = try #require(Self.fixture)
        return (try #require(fixture.relays[name], "fixture without relay \(name)"), fixture.hostId)
    }
    private func records(_ relay: Relay) async throws -> [Record] {
        let (data, _) = try await URLSession.shared.data(from: relay.log)
        return try JSONDecoder().decode([Record].self, from: data)
    }
    private func socket(_ relay: Relay, hostId: String) -> (RelaySocket, Recorder) {
        let grants = AccountGrants { () async throws(AccountGrantError) -> AceGrant in
            AceGrant(token: "fixture-grant", expiresAt: .greatestFiniteMagnitude)
        }
        let recorder = Recorder()
        return (RelaySocket(route: RelayRoute(relayURL: relay.url, hostId: hostId, grants: grants)) { recorder.add($0, $1) }, recorder)
    }
    private let hello = #"{"type":"hello","protocolVersion":1,"deviceId":"ios-live","grant":"fixture-grant","machineCode":"2468"}"#

    /// One connection through `name` up to the daemon's first answer to the hello, and what
    /// the proxy saw of the dials it took. The time is from `open` to that answer.
    private func connect(_ name: String) async throws -> (records: [Record], seconds: Double) {
        let (relay, hostId) = try relay(name)
        let before = try await records(relay).count
        let (socket, events) = socket(relay, hostId: hostId)
        defer { socket.close() }
        let started = ContinuousClock.now
        socket.open()
        try await events.wait { $0.types.contains("open") }
        socket.send(hello)
        try await events.wait { !$0.texts.isEmpty }
        let elapsed = ContinuousClock.now - started
        #expect(events.texts.first == #"{"type":"pong"}"#)
        let seconds = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
        return (Array(try await records(relay).dropFirst(before)), seconds)
    }

    @Test(.enabled(if: fixture != nil))
    func aRelayWithBothShortcutsTakesTheFirstMessageFromTheUpgradeAndNoFrameCarriesIt() async throws {
        let dials = try await connect("full").records
        let dial = try #require(dials.first)
        #expect(dials.count == 1)
        #expect(dial.offered == ["ace.grant.", "ace.v2", "ace.x1.", "ace.early.1"])
        #expect(dial.echoed == "ace.v2")
        // The marker and the daemon's answer come before anything the phone sends.
        #expect(Array(dial.order.prefix(3)) == ["received", "received", "sent"])
    }

    @Test(.enabled(if: fixture != nil))
    func aRelayWithEarlyFramesOnlyGetsTheFirstMessageAsAFrameAtTheOpen() async throws {
        let dials = try await connect("stepOne").records
        let dial = try #require(dials.first)
        #expect(dials.count == 1)
        #expect(dial.echoed == "ace.early.1")
        #expect(Array(dial.order.prefix(3)) == ["sent", "received", "received"])
    }

    @Test(.enabled(if: fixture != nil))
    func anOlderRelayEchoesTheGrantAndTheFirstMessageWaitsForTheMarker() async throws {
        let dials = try await connect("older").records
        let dial = try #require(dials.first)
        #expect(dials.count == 1)
        #expect(dial.echoed == "ace.grant.")
        #expect(Array(dial.order.prefix(3)) == ["received", "sent", "received"])
    }

    @Test(.enabled(if: fixture != nil))
    func aLostEarlyFrameCostsOneDialWithoutEitherShortcut() async throws {
        let dials = try await connect("losing").records
        #expect(dials.count == 2)
        #expect(dials.first?.closed == 4020)
        #expect(dials.last?.offered == ["ace.grant."])
        #expect(dials.last?.echoed == "ace.grant.")
    }

    @Test(.enabled(if: fixture != nil))
    func aRelayThatLosesEveryFrameEndsTheConnectionAfterOneRetryRatherThanLooping() async throws {
        let (relay, hostId) = try relay("alwaysLosing")
        let before = try await records(relay).count
        let (socket, events) = socket(relay, hostId: hostId)
        socket.open()
        try await events.wait { $0.types.contains("close") }
        // Give a loop the time it would need to show itself.
        try await Task.sleep(for: .milliseconds(500))
        #expect(!events.types.contains("open"))
        let dials = Array(try await records(relay).dropFirst(before))
        #expect(dials.count == 2)
        #expect(dials.last?.offered == ["ace.grant."])
    }

    @Test(.enabled(if: fixture != nil))
    func anUpgradeRefusedForCarryingTheMessageIsRetriedOnceWithoutIt() async throws {
        let dials = try await connect("refusing").records
        #expect(dials.count == 2)
        #expect(dials.first?.refused == true)
        #expect(dials.last?.offered == ["ace.grant.", "ace.early.1"])
        #expect(dials.last?.echoed == "ace.early.1")
    }

    /// The figure for #2112: on a link with 200 ms each way, the time from `open` to the
    /// daemon's first answer, with both shortcuts and with neither. Printed for the PR; the
    /// shortcuts save a round trip, so the gap is asserted at half of one.
    @Test(.enabled(if: fixture != nil))
    func onASlowLinkTheShortcutsReachTheDaemonsAnswerARoundTripSooner() async throws {
        var fast: [Double] = [], slow: [Double] = []
        for _ in 0..<5 {
            fast.append(try await connect("slowFull").seconds)
            slow.append(try await connect("slowOlder").seconds)
        }
        let median = { (values: [Double]) in values.sorted()[values.count / 2] }
        print("relay-shortcuts: open to first answer at 200 ms each way: with shortcuts \(Int(median(fast) * 1000)) ms, without \(Int(median(slow) * 1000)) ms (medians of 5)")
        #expect(median(slow) - median(fast) > 0.2)
    }
}
