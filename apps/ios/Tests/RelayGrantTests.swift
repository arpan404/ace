import Foundation
import Testing
@testable import Ace

private let hostId = "A4IOPXUIEEM6GMLBBSWHEDA3CUUI64AG6CB4CALXPPRXWGPSVCRQ"

/// Which grant each relay connection presents, against a loopback WebSocket server.
@Suite(.serialized) struct RelayGrantTests {
    private final class Fetches: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        var count: Int { lock.withLock { value } }
        func next() -> Int { lock.withLock { value += 1; return value } }
    }
    private func until(_ done: () -> Bool) async throws {
        for _ in 0..<250 where !done() { try await Task.sleep(for: .milliseconds(20)) }
        #expect(done())
    }
    /// The grant entry each upgrade offered, first in its header.
    private func grants(_ server: LocalTLSServer) -> [String] {
        server.subprotocols.map { String($0.split(separator: ",").first ?? "") }
    }
    private func route(_ port: UInt16, _ fetches: Fetches) -> RelayRoute {
        RelayRoute(relayURL: URL(string: "ws://127.0.0.1:\(port)")!, hostId: hostId, grants: AccountGrants {
            () async throws(AccountGrantError) -> AceGrant in
            AceGrant(token: "grant-\(fetches.next())", expiresAt: Date().timeIntervalSince1970 * 1000 + 300_000)
        })
    }

    @Test func aReconnectPresentsTheKeptGrantWithoutFetchingAnother() async throws {
        let server = try LocalTLSServer(tls: false)
        let port = try await server.start()
        defer { server.stop() }
        let fetches = Fetches()
        let route = route(port, fetches)
        let first = RelaySocket(route: route) { _, _ in }
        first.open()
        try await until { server.subprotocols.count == 1 }
        first.close()
        let second = RelaySocket(route: route) { _, _ in }
        second.open()
        defer { second.close() }
        try await until { server.subprotocols.count == 2 }
        #expect(grants(server) == ["ace.grant.grant-1", "ace.grant.grant-1"])
        #expect(fetches.count == 1)
    }
    @Test func aGrantTheRelayRefusedIsReplacedOnTheNextConnection() async throws {
        let server = try LocalTLSServer(tls: false)
        server.refuseUpgrades = 401
        let port = try await server.start()
        defer { server.stop() }
        let fetches = Fetches()
        let route = route(port, fetches)
        let closed = Answer()
        let first = RelaySocket(route: route) { kind, payload in
            if kind == "close", case .text(let code) = payload { closed.give(code) }
        }
        first.open()
        #expect(await closed.value() == "1006")
        let second = RelaySocket(route: route) { _, _ in }
        second.open()
        defer { second.close() }
        // Each refused upgrade carried the first message, so it was tried once more without it
        // before its grant counted as refused. The second is refused too, and stops there.
        try await until { server.subprotocols.count >= 4 }
        try await Task.sleep(for: .milliseconds(200))
        #expect(grants(server) == ["ace.grant.grant-1", "ace.grant.grant-1", "ace.grant.grant-2", "ace.grant.grant-2"])
    }
}
