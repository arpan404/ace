import Foundation
import Testing
@testable import Ace

private let relayKey = String(repeating: "R", count: 52)
private let accountDevice = "01936d1e-3f8a-7c2b-9d4e-5f6a7b8c9d0e"

/// An account hello from an install that also paired the machine proves that pairing (ADR 0115),
/// so the daemon answers a send made over either route from one receipt.
@Suite(.timeLimit(.minutes(1))) @MainActor struct PairingLinkProofTests {
    @Test func theProofMatchesTheDaemonsVector() {
        let link = PairingLinkProof(token: "ace-test-token", pairedDeviceId: "dev-paired-1", accountDeviceId: accountDevice)
        #expect(link == PairingLinkProof(token: "ace-test-token", pairedDeviceId: "dev-paired-1", accountDeviceId: accountDevice))
        #expect(link.deviceId == "dev-paired-1")
        #expect(link.proof == "p_YxW23xNBoRAG2ha65bdxvF7ZXb9gcI9lWzyv68q-M")
        #expect(PairingLinkProof(token: "other-token", pairedDeviceId: "dev-paired-1", accountDeviceId: accountDevice).proof != link.proof)
    }

    @Test func thePairedMachinesAccountRouteProvesThePairingAndAnAccountOnlyMachinesDoesNot() async throws {
        let build = String(repeating: "B", count: 52)
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1),
                                            AceMachine(hostId: build, name: "build box", platform: "linux", lastSeenAt: 1)],
                                           deviceId: accountDevice)
        let fixture = try MachinesFixture(machines: [studio()], account: account)
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let direct = try #require(fixture.sessions.started.first { $0.target.hostId == "studio" })
        let buildRuntime = try #require(fixture.sessions.started.first { $0.target.hostId == build })
        let secrets = MemorySecrets()
        try secrets.set(try #require(direct.target.secretKey), "ace-test-token")

        // The LAN stops answering: the machine moves to its account relay.
        direct.finishShutdownWhenStopped()
        direct.emit(#"[{"type":"connection","state":"reconnecting"}]"#)
        for _ in 0..<500 where fixture.sessions.started.count < 3 { try? await Task.sleep(for: .milliseconds(2)) }
        let relay = try #require(fixture.sessions.started.last)
        #expect(relay.target.relay?.hostId == relayKey)
        let config = try start(relay.target, secrets)
        #expect(config.account?.link?.deviceId == "dev-paired-1")
        #expect(config.account?.link?.proof == "p_YxW23xNBoRAG2ha65bdxvF7ZXb9gcI9lWzyv68q-M")
        #expect(config.deviceAliases == ["dev-paired-1"])
        // The token itself never goes over the relay.
        #expect(try #require(ClientRuntime.startConfig(relay.target, itemLimit: 200, inboxSort: nil, secrets: secrets)).contains("ace-test-token") == false)

        // A machine only on the account has no pairing to prove; nor has a direct route.
        #expect(try start(buildRuntime.target, secrets).account != nil)
        #expect(try start(buildRuntime.target, secrets).account?.link == nil)
        #expect(try start(direct.target, secrets).account == nil)
        // Without the paired token in the Keychain, the hello carries no proof.
        #expect(try start(relay.target, MemorySecrets()).account?.link == nil)
    }

    private struct Start: Decodable {
        struct Account: Decodable { let link: Link? }
        struct Link: Decodable { let deviceId: String; let proof: String }
        let account: Account?
        let deviceAliases: [String]?
    }
    private func start(_ target: ConnectionTarget, _ secrets: any SecretStore) throws -> Start {
        let json = try #require(ClientRuntime.startConfig(target, itemLimit: 200, inboxSort: nil, secrets: secrets))
        return try JSONDecoder().decode(Start.self, from: Data(json.utf8))
    }
    private func studio() -> MachineEntry {
        let fingerprint = DaemonCertificate.pin
        return MachineEntry(hostId: "studio", displayName: "Studio", icon: nil,
                            target: .init(kind: "direct", url: "wss://100.64.0.7:4243/", fingerprint: fingerprint), deviceId: "dev-paired-1",
                            paths: [MachinePath(kind: "lan", url: "https://192.168.1.4:4243", fingerprint: fingerprint),
                                    MachinePath(kind: "account", url: "wss://ace.example.com", relayHostId: relayKey)])
    }
}
