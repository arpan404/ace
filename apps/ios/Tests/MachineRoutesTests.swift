import Foundation
import Testing
@testable import Ace

private let relayKey = String(repeating: "R", count: 52)
private let fingerprint = DaemonCertificate.pin

/// One machine per daemon on the phone, whatever routes reach it (ADR 0115).
@Suite(.timeLimit(.minutes(1))) @MainActor struct MachineRoutesTests {
    @Test func aDaemonReachedOverLANAndTailscaleIsOneMachineOnThePhone() async throws {
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let fixture = try MachinesFixture(machines: [studio(paths: allPaths)], account: account)
        defer { fixture.cleanUp() }
        await fixture.model.load()
        #expect(fixture.model.machines.map(\.hostId) == ["studio"])
        #expect(fixture.model.inbox.sessions.map(\.hostId) == ["studio"])
        #expect(fixture.sessions.started.count == 1)
        #expect(fixture.sessions.started[0].target.relay == nil)
        #expect(!fixture.model.inbox.showsMachineNames)
    }

    @Test func aMachinePairedDirectlyAndFoundThroughTheAccountIsOneMachineUsingTheDirectRouteWhileItWorksAndTheRelayWhenItDoesnt() async throws {
        let answers = Answers()
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let fixture = try MachinesFixture(machines: [studio(paths: allPaths)], account: account, probe: { _ in answers.next() })
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let direct = try #require(fixture.sessions.started.first)
        // Each runtime the machine leaves shuts down promptly, as a real one does.
        direct.finishShutdownWhenStopped()
        #expect(direct.target.pin == fingerprint && direct.target.installId == "0190a8b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b")
        direct.emit(row(connection: "ready", thread: "t1"))
        await settle { fixture.model.inbox.row(InboxKey(machineId: "studio", id: "t1")) != nil }

        // The LAN stops answering: the same machine reconnects through ace's relay, on the same cache.
        direct.emit(row(connection: "reconnecting", thread: "t1"))
        await settle { fixture.sessions.started.count == 2 }
        let relay = try #require(fixture.sessions.started.last)
        relay.finishShutdownWhenStopped()
        #expect(relay.target.relay?.hostId == relayKey)
        #expect(relay.target.deviceId == "ios-account-device")
        #expect(relay.storage == direct.storage)
        #expect(relay.storage == ClientModel.database(hostId: "studio", deviceId: "phone-1", in: fixture.storage))
        #expect(fixture.model.inbox.sessions.map(\.hostId) == ["studio"])
        #expect(fixture.model.plans["studio"]?.current == .relay)
        relay.emit(row(connection: "ready", thread: "t1"))
        await settle { fixture.model.inbox.client("studio")?.connection == "ready" }
        #expect(fixture.model.inbox.row(InboxKey(machineId: "studio", id: "t1")) != nil)

        // A new network where the LAN still doesn't answer: it stays on the relay.
        answers.queue = [false]
        fixture.model.network(online: true, interfaceChanged: true)
        await settle { answers.asked == 1 }
        await drain()
        #expect(fixture.sessions.started.count == 2)
        // Back home: the LAN answers its probe and the machine fails back to it.
        answers.queue = [true]
        fixture.model.wake()
        await settle { fixture.sessions.started.count == 3 }
        let back = try #require(fixture.sessions.started.last)
        #expect(back.target.relay == nil && back.target.pin == fingerprint)
        #expect(back.storage == direct.storage)
        #expect(fixture.model.machines.count == 1)
    }

    @Test func aPairedMachineThatNamesItsAccountKeyTakesTheAccountEntryIntoItself() async throws {
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let fixture = try MachinesFixture(machines: [studio(paths: nil)], account: account)
        defer { fixture.cleanUp() }
        await fixture.model.load()
        // Before the daemon has said its paths, the phone can't tell they are one machine.
        #expect(fixture.model.machines.map(\.hostId) == ["studio", relayKey])
        let accountRuntime = try #require(fixture.sessions.started.first { $0.target.relay != nil })
        let direct = try #require(fixture.sessions.started.first { $0.target.relay == nil })
        let paths = try String(decoding: JSONEncoder().encode(allPaths), as: UTF8.self)
        direct.emit(#"[{"type":"connection","state":"ready"},{"type":"machine.identity","glyph":"laptop","hostId":"studio","paths":\#(paths)}]"#)
        await settle { accountRuntime.stopped }
        accountRuntime.finishShutdown()
        await settle { fixture.model.machines.count == 1 }
        #expect(fixture.access.remembered == ["studio"])
        #expect(fixture.model.machines.first?.accountHostId == relayKey)
        #expect(fixture.model.inbox.sessions.map(\.hostId) == ["studio"])
        #expect(!direct.stopped)
    }

    @Test func anAccountMachineWhoseDaemonIsAPairedMachineBecomesThatMachine() async throws {
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let fixture = try MachinesFixture(machines: [studio(paths: nil)], account: account)
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let accountRuntime = try #require(fixture.sessions.started.first { $0.target.relay != nil })
        accountRuntime.emit(#"[{"type":"connection","state":"ready"},{"type":"machine.identity","glyph":"laptop","hostId":"studio"}]"#)
        await settle { accountRuntime.stopped }
        accountRuntime.finishShutdown()
        await settle { fixture.model.machines.count == 1 }
        #expect(fixture.model.machines.first?.hostId == "studio")
        #expect(fixture.model.machines.first?.accountHostId == relayKey)
    }

    private var allPaths: [MachinePath] {
        [MachinePath(kind: "lan", url: "https://192.168.1.4:4243", fingerprint: fingerprint),
         MachinePath(kind: "tailscale", url: "https://100.64.0.7:4243", fingerprint: fingerprint),
         MachinePath(kind: "future", url: "https://example.invalid"),
         MachinePath(kind: "account", url: "wss://ace.example.com", relayHostId: relayKey)]
    }
    private func studio(paths: [MachinePath]?) -> MachineEntry {
        MachineEntry(hostId: "studio", displayName: "Studio", icon: nil,
                     target: .init(kind: "direct", url: "wss://100.64.0.7:4243/", fingerprint: fingerprint), deviceId: "phone-1", paths: paths)
    }
}

/// The route plan's rule on its own: direct while it works, the relay when it doesn't, and back.
@Suite struct MachineRoutePlanTests {
    @Test func theDirectRouteIsLeftForTheRelayOnlyWhenItCantReachTheMachine() {
        var plan = MachineRoutePlan(direct: true, relay: true)
        #expect(plan.current == .direct)
        for state in ["connecting", "ready", "offline", "fatal"] { #expect(plan.connection(state) == .stay) }
        #expect(plan.connection("reconnecting") == .open(.relay))
        #expect(plan.current == .relay)
        // Without a relay there is nowhere else to go.
        var alone = MachineRoutePlan(direct: true, relay: false)
        #expect(alone.connection("reconnecting") == .stay)
    }

    @Test func onTheRelayANewNetworkProbesTheDirectRouteAndOnlyAnAnswerFailsBack() {
        var plan = MachineRoutePlan(direct: true, relay: true)
        _ = plan.connection("reconnecting")
        #expect(plan.networkChanged() == .probeDirect)
        // One probe at a time.
        #expect(plan.networkChanged() == .stay)
        #expect(plan.probed(answered: false) == .stay)
        #expect(plan.current == .relay)
        #expect(plan.connection("reconnecting") == .probeDirect)
        #expect(plan.probed(answered: true) == .open(.direct))
        #expect(plan.current == .direct)
        // On the direct route there is nothing to probe, and a stray answer moves nothing.
        #expect(plan.networkChanged() == .stay)
        #expect(plan.probed(answered: true) == .stay)
    }

    @Test func aRouteThatGoesAwayIsLeftForTheOneThatStays() {
        var plan = MachineRoutePlan(direct: true, relay: true)
        _ = plan.connection("reconnecting")
        #expect(plan.routes(direct: true, relay: false) == .open(.direct))
        #expect(plan.routes(direct: true, relay: true) == .stay)
        #expect(MachineRoutePlan(direct: false, relay: true).current == .relay)
    }
}

private final class Answers: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Bool] = []
    private var count = 0
    var queue: [Bool] { get { lock.withLock { values } } set { lock.withLock { values = newValue } } }
    var asked: Int { lock.withLock { count } }
    func next() -> Bool { lock.withLock { count += 1; return values.isEmpty ? false : values.removeFirst() } }
}

@MainActor private func drain() async { for _ in 0..<20 { await Task.yield() } }
/// Waits, briefly, for frames decoded off the main thread to apply.
@MainActor private func settle(_ done: () -> Bool) async {
    for _ in 0..<500 where !done() { try? await Task.sleep(for: .milliseconds(2)) }
}
/// A runtime's connection and one inbox row in a section.
private func row(connection: String, thread: String) -> String {
    let value = #"{"id":"\#(thread)","title":"Thread","state":"done","project":"ace","branch":"","machine":"","provider":"codex","model":"","agents":1,"updatedAt":1,"canSteer":false,"status":{"label":"Done","token":"done"}}"#
    return #"[{"type":"connection","state":"\#(connection)"},{"type":"inbox.reset"},{"type":"inbox.row","id":"\#(thread)","row":\#(value)},{"type":"inbox.sections","sections":[{"key":"done","label":"Done","ids":["\#(thread)"],"ranks":["1"],"order":0}],"more":false,"snooze":[]}]"#
}
