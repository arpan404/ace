import Foundation
import Testing
@testable import Ace

private let hostA = "A4IOPXUIEEM6GMLBBSWHEDA3CUUI64AG6CB4CALXPPRXWGPSVCRQ"
private let hostB = "B4IOPXUIEEM6GMLBBSWHEDA3CUUI64AG6CB4CALXPPRXWGPSVCRQ"

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.withLock { value } }
    func next() -> Int { lock.withLock { value += 1; return value } }
}
private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Double = 1_000_000
    var now: Double { lock.withLock { value } }
    func advance(_ ms: Double) { lock.withLock { value += ms } }
}

@Suite struct AccountGrantTests {
    @Test func everyRelayConnectionFetchesAFreshGrantAndItsHelloPresentsTheSameOne() async throws {
        let fetches = Counter(), clock = Clock()
        let grants = AccountGrants(now: { clock.now }) { () async throws(AccountGrantError) -> AceGrant in
            AceGrant(token: "grant-\(fetches.next())", expiresAt: clock.now + 300_000)
        }
        #expect(try await grants.fresh() == "grant-1")
        #expect(try await grants.current() == "grant-1")
        #expect(try await grants.fresh() == "grant-2")
        #expect(try await grants.current() == "grant-2")
        // Within a minute of its expiry a grant is not offered again.
        clock.advance(250_000)
        #expect(try await grants.current() == "grant-3")
        #expect(fetches.count == 3)
    }

    @Test func aSignedOutPhoneGetsNoGrantAndTheBackendStatusDecidesRetrying() async throws {
        let grants = AccountGrants { () async throws(AccountGrantError) -> AceGrant in throw .signedOut }
        await #expect(throws: AccountGrantError.signedOut) { try await grants.fresh() }
        #expect(throws: AccountGrantError.signedOut) { try AceAccountAPI.check(status: 401) }
        #expect(throws: AccountGrantError.unavailable) { try AceAccountAPI.check(status: 503) }
        #expect(throws: AccountGrantError.unavailable) { try AceAccountAPI.check(status: 429) }
        #expect(throws: AccountGrantError.refused) { try AceAccountAPI.check(status: 403) }
        try AceAccountAPI.check(status: 200)
    }

    @Test func theRelayIsTheAccountOriginOverWebSocketAndTheHostIdGoesInTheQuery() throws {
        let api = AceAccountAPI(origin: try #require(AceAccountAPI.origin(from: "https://ace.example.com")))
        let relay = try #require(api.relayURL)
        #expect(relay.absoluteString == "wss://ace.example.com")
        let route = RelayRoute(relayURL: relay, hostId: hostA, grants: AccountGrants { () async throws(AccountGrantError) -> AceGrant in throw .signedOut })
        #expect(route.clientURL?.absoluteString == "wss://ace.example.com/client?hostId=\(hostA)")
        #expect(route.isValid)
        // Plain WebSocket only on loopback, for a development backend.
        #expect(AceAccountAPI.origin(from: "http://ace.example.com") == nil)
        let local = AceAccountAPI(origin: try #require(AceAccountAPI.origin(from: "http://127.0.0.1:8787")))
        #expect(local.relayURL?.absoluteString == "ws://127.0.0.1:8787")
        #expect(!RelayRoute(relayURL: relay, hostId: "not-a-host", grants: route.grants).isValid)
    }
}

@Suite struct AccountMachineListTests {
    private func paired(_ hostId: String) -> MachineEntry {
        MachineEntry(hostId: hostId, displayName: "studio", icon: nil,
                     target: .init(kind: "direct", url: "wss://studio.local:7443", fingerprint: String(repeating: "a", count: 64)), deviceId: "phone-1")
    }
    @Test func aMachineBothPairedAndOnTheAccountIsListedOnceTheDirectWay() {
        let account = [AceMachine(hostId: hostA, name: "studio", platform: "darwin", lastSeenAt: 1),
                       AceMachine(hostId: hostB, name: "build box", platform: "linux", lastSeenAt: 2)]
        let merged = AccountMachines.merge(paired: [paired(hostA)], account: account, relayURL: "wss://ace.example.com", deviceId: "ios-1")
        #expect(merged.map(\.hostId) == [hostA, hostB])
        #expect(merged.map(\.isAccountMachine) == [false, true])
        #expect(merged[1].displayName == "build box")
        #expect(merged[1].deviceId == "ios-1")
        // An account entry never claims a direct address the SDK would dial.
        #expect(merged[1].connectionTarget == nil)
    }
}
