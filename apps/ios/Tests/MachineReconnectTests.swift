import Foundation
import Testing
@testable import Ace

private let relayKey = String(repeating: "R", count: 52)
private let install = "0190a8b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b"

/// What a machine's runtime does when the list changes under it: turned off while it was still
/// opening, paired again, or paired while the account already reached it.
@Suite(.timeLimit(.minutes(1))) @MainActor struct MachineReconnectTests {
    @Test func aMachineTurnedOffWhileItsNotificationsBindNeverConnects() async throws {
        let fixture = try MachinesFixture(machines: [machine("studio", device: "phone-1")])
        defer { fixture.cleanUp() }
        let gate = ListGate()
        gate.close()
        var binding = 0
        fixture.model.beforeConnect = { _, _ in binding += 1; await gate.wait() }
        let loading = Task { await fixture.model.load() }
        await settle { binding == 1 }
        await fixture.model.setOn("studio", false)
        gate.open()
        await loading.value
        await drain()
        #expect(fixture.sessions.started.isEmpty)
        #expect(fixture.model.inbox.sessions.isEmpty)
    }

    @Test func aMachineRemovedWhileItsNotificationsBindNeverConnects() async throws {
        let fixture = try MachinesFixture(machines: [machine("studio", device: "phone-1")])
        defer { fixture.cleanUp() }
        let gate = ListGate()
        gate.close()
        var binding = 0
        fixture.model.beforeConnect = { _, _ in binding += 1; await gate.wait() }
        let loading = Task { await fixture.model.load() }
        await settle { binding == 1 }
        await fixture.model.remove("studio")
        gate.open()
        await loading.value
        await drain()
        #expect(fixture.sessions.started.isEmpty)
        #expect(fixture.model.machines.isEmpty)
    }

    @Test func pairingAConnectedMachineAgainReopensItWithTheNewCredentialAndGrants() async throws {
        let fixture = try MachinesFixture(machines: [])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        fixture.access.pairing = .success(machine("studio", device: install), scopes: ["read", "operate"])
        #expect(await fixture.model.pair(try link(), name: "Phone") == nil)
        let first = try #require(fixture.sessions.started.first)
        first.finishShutdownWhenStopped()
        #expect(fixture.model.inbox.client("studio")?.canOperate == true)

        // The daemon closes the old credential's sockets; the new pairing's runtime replaces it.
        fixture.access.pairing = .success(machine("studio", device: install), scopes: ["read"])
        #expect(await fixture.model.pair(try link(), name: "Phone") == nil)
        #expect(first.stopped)
        #expect(fixture.sessions.started.count == 2)
        #expect(fixture.sessions.started.last?.target.hostId == "studio")
        #expect(fixture.model.inbox.sessions.map(\.hostId) == ["studio"])
        #expect(fixture.model.inbox.client("studio")?.canOperate == false)
        #expect(fixture.model.isReadOnly("studio"))
    }

    @Test func pairingAMachineTheAccountAlreadyReachesLeavesOneRuntimeForIt() async throws {
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let fixture = try MachinesFixture(machines: [], account: account)
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let accountRuntime = try #require(fixture.sessions.started.first)
        #expect(accountRuntime.target.relay?.hostId == relayKey)
        accountRuntime.finishShutdownWhenStopped()

        // The paired entry's saved paths name the account machine: it is that machine.
        var studio = machine("studio", device: install)
        studio.paths = [MachinePath(kind: "account", url: "wss://ace.example.com", relayHostId: relayKey)]
        fixture.access.pairing = .success(studio, scopes: ["read", "operate"])
        #expect(await fixture.model.pair(try link(), name: "Phone") == nil)
        #expect(fixture.model.machines.map(\.hostId) == ["studio"])
        #expect(fixture.model.inbox.sessions.map(\.hostId) == ["studio"])
        #expect(fixture.model.inbox.client(relayKey) == nil)
        #expect(accountRuntime.stopped)
        #expect(fixture.sessions.started.filter { !$0.stopped }.count == 1)
    }

    private func link() throws -> PairingLink {
        try PairingLink.parse("https://127.0.0.1:4611/pair#fingerprint=\(DaemonCertificate.pin)&code=abc")
    }
    private func machine(_ host: String, device: String) -> MachineEntry {
        MachineEntry(hostId: host, displayName: host.capitalized, icon: nil,
                     target: .init(kind: "direct", url: "wss://100.64.0.7:4243/", fingerprint: DaemonCertificate.pin), deviceId: device)
    }
}

@MainActor private func drain() async { for _ in 0..<20 { await Task.yield() } }
@MainActor private func settle(_ done: () -> Bool) async {
    for _ in 0..<500 where !done() { try? await Task.sleep(for: .milliseconds(2)) }
}
