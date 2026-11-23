import Foundation
import Testing
@testable import Ace

/// The relay socket proving the person's standing (ADR 0190 §3) against the real Node relay and
/// its stand-in daemon (`scripts/relay-fixture.ts`, device `ios-standing`). The stand-in takes a
/// proof only if its signature verifies over this socket's own nonce and Noise handshake hash, and
/// then stands for two seconds. Runs when the fixture's JSON is passed as `TEST_RUNNER_ACE_RELAY_FIXTURE`.
@Suite(.timeLimit(.minutes(1))) struct RelayStandingLiveTests {
    private struct Fixture: Decodable { let url: URL; let hostId: String }
    private static let fixture: Fixture? = ProcessInfo.processInfo.environment["ACE_RELAY_FIXTURE"]
        .flatMap { try? JSONDecoder().decode(Fixture.self, from: Data($0.utf8)) }

    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var events: [(String, String)] = []
        func add(_ type: String, _ value: SocketPayload) {
            guard case .text(let text) = value else { return }
            lock.withLock { events.append((type, text)) }
        }
        var texts: [String] { lock.withLock { events.filter { $0.0 == "message" }.map(\.1) } }
        var types: [String] { lock.withLock { events.map(\.0) } }
        var verdicts: [String] { lock.withLock { events.filter { $0.0 == "standing" }.map(\.1) } }
        func wait(_ done: @escaping (Recorder) -> Bool) async throws {
            for _ in 0..<500 where !done(self) { try await Task.sleep(for: .milliseconds(20)) }
            #expect(done(self), "events: \(lock.withLock { events.map(\.0) })")
        }
    }

    /// `person` is the backend's answer to each request for the person's grant, by its number from 1.
    private func socket(person: @escaping @Sendable (_ phoneKey: String, _ request: Int) throws(AccountGrantError) -> String?) throws -> (RelaySocket, Recorder) {
        let fixture = try #require(Self.fixture)
        let requests = Counter()
        let grants = AccountGrants(person: { _, phoneKey throws(AccountGrantError) in try person(phoneKey, requests.next()) }) { () async throws(AccountGrantError) -> AceGrant in
            AceGrant(token: "fixture-grant", expiresAt: .greatestFiniteMagnitude)
        }
        var route = RelayRoute(relayURL: fixture.url, hostId: fixture.hostId, grants: grants)
        route.standingKey = DeviceStandingKey.make()
        let recorder = Recorder()
        return (RelaySocket(route: route) { recorder.add($0, $1) }, recorder)
    }
    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        func next() -> Int { lock.withLock { count += 1; return count } }
    }
    private let hello = String(decoding: try! JSONSerialization.data(withJSONObject: [
        "type": "hello", "protocolVersion": 1, "deviceId": "ios-standing", "grant": "fixture-grant", "machineCode": "2468",
    ]), as: UTF8.self)

    @Test(.enabled(if: fixture != nil))
    func theSocketSendsItsProofAndTheScriptHearsOnlyTheVerdictThenItsLapse() async throws {
        // The backend can't be reached for the renewal, as when it rate-limits the phone.
        let (socket, events) = try socket { key, request throws(AccountGrantError) in
            if request > 1 { throw .unavailable }
            return "fixture-person.\(key)"
        }
        defer { socket.close() }
        socket.open()
        try await events.wait { $0.types.contains("open") }
        socket.send(hello)
        // The stand-in only says `ok` to a signature over this socket's own challenge and binding.
        try await events.wait { $0.verdicts == ["proven relay"] }
        #expect(events.texts.allSatisfy { !$0.contains("account.standing") })
        // It stands for two seconds; without a renewal in time the verdict is cleared.
        try await events.wait { $0.verdicts.last == "cleared relay" }
        #expect(events.verdicts.first == "proven relay")
    }

    @Test(.enabled(if: fixture != nil))
    func aProofForAnotherKeyIsRefusedAndTheScriptHearsMissing() async throws {
        let (socket, events) = try socket { _, _ in "fixture-person.\(DeviceStandingKey.make().publicKey)" }
        defer { socket.close() }
        socket.open()
        try await events.wait { $0.types.contains("open") }
        socket.send(hello)
        try await events.wait { !$0.verdicts.isEmpty }
        #expect(events.verdicts == ["missing relay"])
    }
}
