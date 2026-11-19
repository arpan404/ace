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

        // Past the hold, a new network where the LAN still doesn't answer: it stays on the relay.
        fixture.clock.advance(MachineRoutePlan.hold)
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

    @Test func aNetworkChangeInsideTheHoldProbesTheDirectRouteWhenTheHoldEndsWithNoOtherEvent() async throws {
        let answers = Answers()
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let fixture = try MachinesFixture(machines: [studio(paths: allPaths)], account: account, probe: { _ in answers.next() })
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let direct = try #require(fixture.sessions.started.first)
        direct.finishShutdownWhenStopped()
        direct.emit(row(connection: "reconnecting", thread: "t1"))
        await settle { fixture.sessions.started.count == 2 }
        let relay = try #require(fixture.sessions.started.last)
        relay.finishShutdownWhenStopped()
        relay.emit(row(connection: "ready", thread: "t1"))
        await settle { fixture.model.inbox.client("studio")?.connection == "ready" }

        // Home again 5 s later: too soon to leave the relay, and nothing else happens after.
        fixture.clock.advance(5_000)
        answers.queue = [true]
        fixture.model.network(online: true, interfaceChanged: true)
        await settle { fixture.scheduler.pending == 1 }
        #expect(answers.asked == 0)
        // The hold ends: the direct route is probed, answers, and the machine moves back to it.
        fixture.scheduler.advance(MachineRoutePlan.hold - 5_000)
        await settle { fixture.sessions.started.count == 3 }
        #expect(answers.asked == 1)
        #expect(fixture.sessions.started.last?.target.relay == nil)
        #expect(fixture.model.plans["studio"]?.current == .direct)
    }

    @Test func aRelayThatAsksForTheMachineCodeGivesWayToADirectRouteThatAnswersAndTheCodeIsNotAskedThere() async throws {
        let answers = Answers()
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let fixture = try MachinesFixture(machines: [studio(paths: allPaths)], account: account, probe: { _ in answers.next() })
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let direct = try #require(fixture.sessions.started.first)
        direct.finishShutdownWhenStopped()
        direct.emit(row(connection: "reconnecting", thread: "t1"))
        await settle { fixture.sessions.started.count == 2 }
        let relay = try #require(fixture.sessions.started.last)
        relay.finishShutdownWhenStopped()
        // The relay's daemon wants this install's code: the relay stops and asks for it.
        relay.emit(#"[{"type":"machine.code","asking":"machine_code_required"},{"type":"connection","state":"fatal"}]"#)
        await settle { fixture.model.inbox.client("studio")?.machineCodeAsk == .required }
        // Reachable and waiting for the person: the header says so, never that it can't be reached.
        #expect(InboxConnectionProblem.of(fixture.model.inbox)?.text == "Your machine needs its machine code")
        // Once the hold is over, the LAN answers: the machine opens there with its pairing.
        answers.queue = [true]
        fixture.scheduler.advance(MachineRoutePlan.hold)
        await settle { fixture.sessions.started.count == 3 }
        #expect(fixture.sessions.started.last?.target.relay == nil)
        #expect(fixture.model.inbox.client("studio")?.machineCodeAsk == nil)
        fixture.sessions.started[2].emit(row(connection: "ready", thread: "t1"))
        await settle { fixture.model.inbox.client("studio")?.connection == "ready" }
        #expect(fixture.model.inbox.client("studio")?.machineCodeAsk == nil)
    }

    @Test func aLaterLookAtTheRouteIsCancelledWhenTheMachineIsTurnedOff() async throws {
        let answers = Answers()
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let fixture = try MachinesFixture(machines: [studio(paths: allPaths)], account: account, probe: { _ in answers.next() })
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let direct = try #require(fixture.sessions.started.first)
        direct.finishShutdownWhenStopped()
        direct.emit(row(connection: "reconnecting", thread: "t1"))
        await settle { fixture.sessions.started.count == 2 }
        fixture.sessions.started[1].finishShutdownWhenStopped()
        fixture.model.wake()
        await settle { fixture.scheduler.pending == 1 }
        await fixture.model.setOn("studio", false)
        #expect(fixture.scheduler.pending == 0)
        fixture.scheduler.advance(MachineRoutePlan.hold)
        await drain()
        #expect(answers.asked == 0)
        #expect(fixture.sessions.started.count == 2)
    }

    @Test func aRelayTheAccountListsAfterTheDirectRouteStoppedReachingTheMachineIsTakenAtOnce() async throws {
        let account = FakeAccountDirectory([])
        let fixture = try MachinesFixture(machines: [studio(paths: allPaths)], account: account)
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let direct = try #require(fixture.sessions.started.first)
        direct.finishShutdownWhenStopped()
        // The LAN stops answering before the account has listed the machine: nowhere else to go.
        direct.emit(row(connection: "reconnecting", thread: "t1"))
        await drain()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(fixture.sessions.started.count == 1)
        // The account lists it now; the runtime, still reconnecting, says nothing new.
        account.list([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        await fixture.model.refreshAccount()
        await settle { fixture.sessions.started.count == 2 }
        #expect(fixture.sessions.started.last?.target.relay?.hostId == relayKey)
        #expect(fixture.model.machines.map(\.hostId) == ["studio"])
    }

    @Test func aMachineReachedBothWaysSendsWhatEitherRouteSavedAsTheOther() async throws {
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let fixture = try MachinesFixture(machines: [studio(paths: allPaths)], account: account)
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let direct = try #require(fixture.sessions.started.first)
        direct.finishShutdownWhenStopped()
        #expect(direct.target.deviceAliases == ["ios-account-device"])
        direct.emit(row(connection: "reconnecting", thread: "t1"))
        await settle { fixture.sessions.started.count == 2 }
        let relay = try #require(fixture.sessions.started.last)
        #expect(relay.target.deviceId == "ios-account-device" && relay.target.deviceAliases == ["phone-1"])
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

    @Test func aMachineRenamedFromAnotherDeviceTakesItsNewNameOnThisPhoneWhenItConnects() async throws {
        let fixture = try MachinesFixture(machines: [studio(paths: nil)])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let direct = try #require(fixture.sessions.started.first)
        direct.emit(#"[{"type":"connection","state":"ready"},{"type":"machine.identity","glyph":"laptop","hostId":"studio","name":"Studio Mac"}]"#)
        await settle { fixture.model.machines.first?.displayName == "Studio Mac" }
        #expect(fixture.access.renamed == ["Studio Mac"])
        #expect(fixture.model.inbox.name("studio") == "Studio Mac")
        // The same name on the next connection changes nothing.
        direct.emit(#"[{"type":"connection","state":"ready"},{"type":"machine.identity","glyph":"laptop","hostId":"studio","name":"Studio Mac"}]"#)
        await drain()
        #expect(fixture.access.renamed == ["Studio Mac"])
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

    @Test func aSendTheAccountRuntimeSavedMovesToThePairedMachineItTurnsOutToBeAndIsReadThereOnce() async throws {
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let fixture = try MachinesFixture(machines: [studio(paths: nil)], account: account)
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let accountRuntime = try #require(fixture.sessions.started.first { $0.target.relay != nil })
        let direct = try #require(fixture.sessions.started.first { $0.target.relay == nil })
        direct.finishShutdownWhenStopped()
        // Queued through the account entry while the phone couldn't yet tell they were one machine.
        let send = #"{"command":{"id":"queued-on-relay","deviceId":"ios-account-device","payload":{"type":"thread.archive","threadId":"t1"}},"hostId":"studio","state":"pending","order":1}"#
        let saved = try DurableStore(url: accountRuntime.storage)
        _ = try saved.perform(HostRequest("storage.host.save", body: "studio"))
        _ = try saved.perform(HostRequest("storage.write", input: Data(#"{"id":"queued-on-relay"}"#.utf8), body: send))
        // Another daemon's send stays where it was.
        let other = #"{"command":{"id":"for-another","deviceId":"ios-account-device","payload":{"type":"thread.archive","threadId":"t2"}},"hostId":"elsewhere","state":"pending","order":2}"#
        _ = try saved.perform(HostRequest("storage.write", input: Data(#"{"id":"for-another"}"#.utf8), body: other))
        let startedBefore = fixture.sessions.started.count

        accountRuntime.emit(#"[{"type":"connection","state":"ready"},{"type":"machine.identity","glyph":"laptop","hostId":"studio"}]"#)
        await settle { accountRuntime.stopped }
        accountRuntime.finishShutdown()
        await settle { fixture.model.machines.count == 1 && fixture.sessions.started.count > startedBefore }
        // The paired runtime opened again on its own store, which now holds the send, once: over
        // the relay, whose hello links the account's id to the pairing before anything is sent.
        let reopened = try #require(fixture.sessions.started.last)
        #expect(reopened.storage == direct.storage && reopened.target.relay?.hostId == relayKey)
        #expect(reopened.target.deviceAliases == ["phone-1"])
        #expect(try records(direct.storage) == [send])
        #expect(try records(accountRuntime.storage) == [other])
        #expect(fixture.model.inbox.sessions.map(\.hostId) == ["studio"])
    }

    private func records(_ database: URL) throws -> [String] {
        try JSONDecoder().decode([String].self, from: Data(DurableStore(url: database).perform(HostRequest("storage.records")).utf8))
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
        for state in ["connecting", "ready", "offline", "fatal"] { #expect(plan.connection(state, at: 0) == .stay) }
        #expect(plan.connection("reconnecting", at: 0) == .open(.relay))
        #expect(plan.current == .relay)
        // Without a relay there is nowhere else to go.
        var alone = MachineRoutePlan(direct: true, relay: false)
        #expect(alone.connection("reconnecting", at: 0) == .stay)
    }

    @Test func onTheRelayANewNetworkProbesTheDirectRouteAndOnlyAnAnswerFailsBack() {
        var plan = MachineRoutePlan(direct: true, relay: true)
        _ = plan.connection("reconnecting", at: 0)
        let later = MachineRoutePlan.hold
        #expect(plan.networkChanged(at: later) == .probeDirect)
        // One probe at a time.
        #expect(plan.networkChanged(at: later) == .stay)
        #expect(plan.probed(answered: false, at: later) == .stay)
        #expect(plan.current == .relay)
        #expect(plan.connection("reconnecting", at: later) == .probeDirect)
        #expect(plan.probed(answered: true, at: later) == .open(.direct))
        #expect(plan.current == .direct)
        // On the direct route there is nothing to probe, and a stray answer moves nothing.
        #expect(plan.networkChanged(at: later) == .stay)
        #expect(plan.probed(answered: true, at: later) == .stay)
    }

    @Test func aRelayThatArrivesWhileTheDirectRouteCantReachTheMachineIsTakenAtOnce() {
        var plan = MachineRoutePlan(direct: true, relay: false)
        #expect(plan.connection("reconnecting", at: 0) == .stay)
        // The account lists the machine's relay only now; the runtime reports nothing new.
        #expect(plan.routes(direct: true, relay: true, at: 1) == .open(.relay))
        #expect(plan.current == .relay)
        // A relay that arrives while direct works changes nothing.
        var working = MachineRoutePlan(direct: true, relay: false)
        _ = working.connection("ready", at: 0)
        #expect(working.routes(direct: true, relay: true, at: 1) == .stay)
    }

    @Test func theRelayIsKeptForTheHoldBeforeTheDirectRouteIsTriedAgain() {
        var plan = MachineRoutePlan(direct: true, relay: true)
        #expect(plan.connection("reconnecting", at: 1_000) == .open(.relay))
        #expect(plan.networkChanged(at: 1_000 + MachineRoutePlan.hold - 1) == .reconsider(at: 1_000 + MachineRoutePlan.hold))
        #expect(plan.networkChanged(at: 1_000 + MachineRoutePlan.hold) == .probeDirect)
    }

    @Test func aRequestInsideTheHoldOrCooldownSaysWhenToLookAgain() {
        var plan = MachineRoutePlan(direct: true, relay: true)
        _ = plan.connection("reconnecting", at: 0)
        // The LAN comes back 5 s after the relay was taken: look again when the hold ends.
        #expect(plan.networkChanged(at: 5_000) == .reconsider(at: MachineRoutePlan.hold))
        #expect(plan.connection("reconnecting", at: 6_000) == .reconsider(at: MachineRoutePlan.hold))
        #expect(plan.networkChanged(at: MachineRoutePlan.hold) == .probeDirect)
        // A move back that fails before ready: the cooldown's end is the next look.
        let back = MachineRoutePlan.hold
        _ = plan.probed(answered: true, at: back)
        _ = plan.connection("reconnecting", at: back)
        #expect(plan.networkChanged(at: back + 1_000) == .reconsider(at: back + MachineRoutePlan.cooldown))
        // On the direct route, or with no direct route, there is nothing to look at later.
        var direct = MachineRoutePlan(direct: true, relay: true)
        #expect(direct.networkChanged(at: 0) == .stay)
        var relayOnly = MachineRoutePlan(direct: false, relay: true)
        #expect(relayOnly.networkChanged(at: 0) == .stay)
    }

    @Test func aDirectRouteThatAnswersButDoesntHoldWaitsLongerEachTimeBeforeItIsTriedAgain() {
        var plan = MachineRoutePlan(direct: true, relay: true)
        var now: Double = 0
        _ = plan.connection("reconnecting", at: now)
        var waits: [Double] = []
        for _ in 0..<3 {
            // Probe until the plan lets it, then fail back and lose the connection before ready.
            var waited: Double = 0
            while plan.networkChanged(at: now + waited) != .probeDirect { waited += 1_000 }
            waits.append(waited)
            now += waited
            #expect(plan.probed(answered: true, at: now) == .open(.direct))
            #expect(plan.connection("reconnecting", at: now) == .open(.relay))
        }
        #expect(waits == [MachineRoutePlan.hold, MachineRoutePlan.cooldown, 2 * MachineRoutePlan.cooldown])
        // A move back that reaches ready proves the route: the wait starts over.
        now += 2 * MachineRoutePlan.cooldown * 2
        #expect(plan.networkChanged(at: now) == .probeDirect)
        _ = plan.probed(answered: true, at: now)
        _ = plan.connection("ready", at: now)
        _ = plan.connection("reconnecting", at: now)
        #expect(plan.networkChanged(at: now + MachineRoutePlan.hold) == .probeDirect)
    }

    @Test func aRouteThatGoesAwayIsLeftForTheOneThatStays() {
        var plan = MachineRoutePlan(direct: true, relay: true)
        _ = plan.connection("reconnecting", at: 0)
        #expect(plan.routes(direct: true, relay: false, at: 0) == .open(.direct))
        #expect(plan.routes(direct: true, relay: true, at: 0) == .stay)
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
