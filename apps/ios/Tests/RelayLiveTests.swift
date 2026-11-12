import Foundation
import Testing
@testable import Ace

/// The relay socket against the real Node relay and a stand-in daemon (`scripts/relay-fixture.ts`).
/// Runs when the fixture is up and its JSON is passed as `TEST_RUNNER_ACE_RELAY_FIXTURE`.
@Suite(.timeLimit(.minutes(1))) struct RelayLiveTests {
    private struct Fixture: Decodable { let url: URL; let hostId: String }
    private static let fixture: Fixture? = ProcessInfo.processInfo.environment["ACE_RELAY_FIXTURE"]
        .flatMap { try? JSONDecoder().decode(Fixture.self, from: Data($0.utf8)) }

    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var events: [(String, SocketPayload)] = []
        func add(_ type: String, _ value: SocketPayload) { lock.withLock { events.append((type, value)) } }
        var texts: [String] { lock.withLock { events.compactMap { if $0.0 == "message", case .text(let t) = $0.1 { t } else { nil } } } }
        var types: [String] { lock.withLock { events.map(\.0) } }
        var closeCode: String? { lock.withLock { events.last { $0.0 == "close" }.flatMap { if case .text(let t) = $0.1 { t } else { nil } } } }
        func wait(_ done: @escaping (Recorder) -> Bool) async throws {
            for _ in 0..<500 where !done(self) { try await Task.sleep(for: .milliseconds(20)) }
            #expect(done(self), "events: \(types)")
        }
    }
    private func socket(hostId: String? = nil, grants: Int = 0) throws -> (RelaySocket, Recorder) {
        let fixture = try #require(Self.fixture)
        let route = RelayRoute(relayURL: fixture.url, hostId: hostId ?? fixture.hostId,
                               grants: AccountGrants { () async throws(AccountGrantError) -> AceGrant in AceGrant(token: "fixture-grant", expiresAt: .greatestFiniteMagnitude) })
        let recorder = Recorder()
        return (RelaySocket(route: route) { recorder.add($0, $1) }, recorder)
    }
    private func hello(code: String? = nil, device: String = "ios-live") -> String {
        var hello: [String: Any] = ["type": "hello", "protocolVersion": 1, "deviceId": device, "grant": "fixture-grant"]
        if let code { hello["machineCode"] = code }
        return String(decoding: try! JSONSerialization.data(withJSONObject: hello), as: UTF8.self)
    }

    @Test(.enabled(if: fixture != nil))
    func aDaemonThatWantsItsMachineCodeRefusesTheHelloAndClosesTheChannel() async throws {
        let (socket, events) = try socket()
        socket.open()
        try await events.wait { $0.types.contains("open") }
        socket.send(hello())
        try await events.wait { $0.types.contains("close") }
        #expect(events.texts.first?.contains("machine_code_required") == true)
    }

    @Test(.enabled(if: fixture != nil))
    func theRightCodeOpensTheChannelAndDeflatedBulkMessagesArriveAsText() async throws {
        let (socket, events) = try socket()
        defer { socket.close() }
        socket.open()
        try await events.wait { $0.types.contains("open") }
        socket.send(hello(code: "2468"))
        try await events.wait { $0.texts.count >= 2 }
        #expect(events.texts[0] == #"{"type":"pong"}"#)
        // 420 KB of JSON the stand-in deflated, because the socket's hello offered deflate-raw.
        let bulk = try #require(try JSONSerialization.jsonObject(with: Data(events.texts[1].utf8)) as? [String: Any])
        #expect((bulk["message"] as? String)?.count == 420_000)
        socket.send(#"{"type":"ping"}"#)
        try await events.wait { $0.texts.count >= 3 }
        #expect(events.texts[2] == #"{"type":"pong"}"#)
        #expect(!events.types.contains("close"))
    }

    @Test(.enabled(if: fixture != nil))
    func aStreamManyFlowWindowsLongArrivesWholeBecauseThePhoneReturnsCredit() async throws {
        let (socket, events) = try socket()
        defer { socket.close() }
        socket.open()
        try await events.wait { $0.types.contains("open") }
        socket.send(hello(code: "2468", device: "ios-stream"))
        // The pong, then 40 messages of 200 KB: 8 MB, eight windows of 1 MiB.
        try await events.wait { $0.texts.count >= 41 }
        #expect(events.texts.last?.contains("fixture_stream_39") == true)
        // The phone's own sends are flow controlled too, and still answered.
        socket.send(#"{"type":"ping"}"#)
        try await events.wait { $0.texts.count >= 42 }
        #expect(events.texts.last == #"{"type":"pong"}"#)
        #expect(!events.types.contains("close"))
    }

    @Test(.enabled(if: fixture != nil))
    func aHostIdNoMachineAnswersForNeverOpens() async throws {
        // A well-formed host id the relay has no registration for: the relay refuses the client.
        let (socket, events) = try socket(hostId: String(repeating: "A", count: 52))
        socket.open()
        try await events.wait { $0.types.contains("close") }
        #expect(!events.types.contains("open"))
    }
}
