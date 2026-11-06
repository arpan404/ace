import Foundation
import Testing
@testable import Ace

/// Turning a machine off on this phone: listed and paired, but no runtime, rows or notifications.
@Suite(.timeLimit(.minutes(1))) @MainActor struct MachineTurnOffTests {
    @Test func aTurnedOffMachinesThreadsLeaveTheInboxAndComeBackWhenTurnedOn() async throws {
        let fixture = try MachinesFixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let (studio, laptop) = (fixture.sessions.started[0], fixture.sessions.started[1])
        studio.emit(row(connection: "ready", thread: "s1"))
        laptop.emit(row(connection: "ready", thread: "l1"))
        let laptopRow = InboxKey(machineId: "laptop", id: "l1")
        await settle { fixture.model.inbox.row(laptopRow) != nil }

        let turningOff = Task { await fixture.model.setOn("laptop", false) }
        await settle { laptop.stopped }
        #expect(fixture.model.inbox.row(laptopRow) == nil)
        #expect(fixture.model.inbox.merged.sections.flatMap(\.rows) == [InboxKey(machineId: "studio", id: "s1")])
        laptop.finishShutdown()
        await turningOff.value
        // Still listed, quietly marked; the other machine is untouched.
        #expect(fixture.model.machines.map(\.hostId) == ["studio", "laptop"])
        #expect(fixture.model.isOff("laptop"))
        #expect(MachineFacts(inbox: fixture.model.inbox, machines: fixture.model, hostId: "laptop").subtitle == "Off on this iPhone")
        #expect(!studio.stopped)

        // A relaunch keeps it off: no runtime starts for it.
        let relaunch = try MachinesFixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")],
                                           defaults: fixture.defaults)
        await relaunch.model.load()
        #expect(relaunch.sessions.started.map(\.target.hostId) == ["studio"])

        // On again: the same credential and cache, and its threads are back.
        await fixture.model.setOn("laptop", true)
        let again = try #require(fixture.sessions.started.last)
        #expect(fixture.sessions.started.count == 3)
        #expect(again.target.hostId == "laptop" && again.target.secretKey == laptop.target.secretKey)
        #expect(again.storage == laptop.storage)
        again.emit(row(connection: "ready", thread: "l1"))
        await settle { fixture.model.inbox.row(laptopRow) != nil }
        #expect(fixture.model.inbox.row(laptopRow) != nil)
        #expect(!fixture.model.isOff("laptop"))
    }

    @Test func turningAMachineOffNeverUnpairsIt() async throws {
        let build = String(repeating: "B", count: 52)
        let account = FakeAccountDirectory([AceMachine(hostId: build, name: "build box", platform: "linux", lastSeenAt: 1)])
        let fixture = try MachinesFixture(machines: [machine("studio", device: "phone-1")], account: account)
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let cache = ClientModel.database(hostId: "studio", deviceId: "phone-1", in: fixture.storage)
        try FileManager.default.createDirectory(at: fixture.storage, withIntermediateDirectories: true)
        try Data("kept".utf8).write(to: cache)
        for session in fixture.sessions.started { session.finishShutdownWhenStopped() }

        await fixture.model.setOn("studio", false)
        await fixture.model.setOn(build, false)
        #expect(fixture.access.removed.isEmpty)
        #expect(account.forgotten.isEmpty)
        #expect(fixture.model.machines.map(\.hostId) == ["studio", build])
        #expect(!fixture.model.isReadOnly("studio"))
        #expect(FileManager.default.fileExists(atPath: cache.path))
        // The directory still holds it when read again.
        await fixture.model.refreshAccount()
        #expect(fixture.model.machines.map(\.hostId) == ["studio", build])
        #expect(fixture.model.inbox.sessions.isEmpty)
    }

    @Test func aTurnedOffMachineShowsNoNotificationsAndItsOldOnesAreWithdrawn() async throws {
        let suite = "ace.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let center = Center()
        let coordinator = NotificationCoordinator(center: center, authorizer: Allowed(), defaults: defaults, now: { 0 },
                                                  connectInBackground: { _ in [] })
        for (host, thread) in [("studio", "s1"), ("laptop", "l1")] {
            await coordinator.desk.land(AlertNotification(id: "a-\(thread)", threadId: thread, title: "Fix it", status: "needs_you",
                                                          interactionId: nil, backgroundCount: 0, actions: [], preview: nil, message: nil),
                                        hostId: host)
        }
        #expect(coordinator.presentation(for: "l1", hostId: "laptop") != [])

        // Turned off from the machine list, which stores it where notifications read it.
        let fixture = try MachinesFixture(machines: [machine("laptop", device: "phone-2")], defaults: defaults)
        await fixture.model.load()
        fixture.sessions.started[0].finishShutdownWhenStopped()
        fixture.model.afterTurnOff = { coordinator.turnedOff($0) }
        await fixture.model.setOn("laptop", false)
        #expect(center.withdrawn == [AlertStack.thread("l1", hostId: "laptop")])
        #expect(coordinator.presentation(for: "l1", hostId: "laptop") == [])
        #expect(coordinator.presentation(for: "s1", hostId: "studio") != [])
    }

    @Test func anAccountMachineTurnedOffStaysOffOnceItIsKnownToBeAPairedOne() async throws {
        let relayKey = String(repeating: "R", count: 52)
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let fixture = try MachinesFixture(machines: [machine("studio", device: "phone-1")], account: account)
        defer { fixture.cleanUp() }
        await fixture.model.load()
        #expect(fixture.model.machines.map(\.hostId) == ["studio", relayKey])
        for session in fixture.sessions.started { session.finishShutdownWhenStopped() }
        await fixture.model.setOn(relayKey, false)

        // The paired machine says ace's relay knows it by that key: one machine, still off.
        let direct = try #require(fixture.sessions.started.first { $0.target.relay == nil })
        let paths = #"[{"kind":"account","url":"wss://ace.example.com","relayHostId":"\#(relayKey)"}]"#
        direct.emit(#"[{"type":"connection","state":"ready"},{"type":"machine.identity","glyph":"laptop","hostId":"studio","paths":\#(paths)}]"#)
        await settle { fixture.model.machines.count == 1 && direct.stopped }
        #expect(fixture.model.machines.map(\.hostId) == ["studio"])
        #expect(fixture.model.isOff("studio"))
        #expect(direct.stopped)
        #expect(fixture.model.inbox.sessions.isEmpty)
        #expect(MachinesModel.turnedOff(in: fixture.defaults) == ["studio", relayKey])

        // Turning it on clears it under both ids.
        await fixture.model.setOn("studio", true)
        #expect(!fixture.model.isOff("studio") && !fixture.model.isOff(relayKey))
        #expect(MachinesModel.turnedOff(in: fixture.defaults).isEmpty)
        #expect(fixture.model.inbox.sessions.map(\.hostId) == ["studio"])
    }

    @Test func anAccountMachineFoundToBeAnOffPairingHasTheNotificationsItDeliveredWithdrawn() async throws {
        let relayKey = String(repeating: "R", count: 52)
        let account = FakeAccountDirectory([AceMachine(hostId: relayKey, name: "studio", platform: "darwin", lastSeenAt: 1)])
        let fixture = try MachinesFixture(machines: [machine("studio", device: "phone-1")], account: account)
        defer { fixture.cleanUp() }
        let center = Center()
        let coordinator = NotificationCoordinator(center: center, authorizer: Allowed(), defaults: fixture.defaults, now: { 0 },
                                                  connectInBackground: { _ in [] })
        fixture.model.afterTurnOff = { coordinator.turnedOff($0) }
        fixture.model.afterRemove = { model, _ in coordinator.detach(model) }
        await fixture.model.load()
        for session in fixture.sessions.started { session.finishShutdownWhenStopped() }
        // The pairing is off; the account entry, not yet known to be it, delivered an alert.
        await fixture.model.setOn("studio", false)
        await coordinator.desk.land(AlertNotification(id: "a-r1", threadId: "r1", title: "Fix it", status: "needs_you",
                                                      interactionId: nil, backgroundCount: 0, actions: [], preview: nil, message: nil),
                                    hostId: relayKey)
        #expect(coordinator.presentation(for: "r1", hostId: relayKey) != [])

        let accountRuntime = try #require(fixture.sessions.started.first { $0.target.relay != nil })
        accountRuntime.emit(#"[{"type":"connection","state":"ready"},{"type":"machine.identity","glyph":"laptop","hostId":"studio"}]"#)
        await settle { fixture.model.machines.count == 1 && center.withdrawn.contains(AlertStack.thread("r1", hostId: relayKey)) }
        #expect(fixture.model.machines.map(\.hostId) == ["studio"])
        #expect(center.withdrawn.contains(AlertStack.thread("r1", hostId: relayKey)))
        #expect(center.delivered.isEmpty)
        #expect(coordinator.presentation(for: "r1", hostId: relayKey) == [])
        #expect(MachinesModel.turnedOff(in: fixture.defaults) == ["studio", relayKey])
    }

    @Test func aViewOnlyPairingWithOneMachineNeverChangesWhatAnotherPairingWithTheSameInstallAllows() async throws {
        let install = "0190a8b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b"
        let fixture = try MachinesFixture(machines: [])
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let link = try PairingLink.parse("https://127.0.0.1:4611/pair#fingerprint=\(DaemonCertificate.pin)&code=abc&scopes=read")
        fixture.access.pairing = .success(machine("studio", device: install), scopes: ["read", "operate"])
        #expect(await fixture.model.pair(link, name: "Phone") == nil)
        fixture.access.pairing = .success(machine("laptop", device: install), scopes: ["read"])
        #expect(await fixture.model.pair(link, name: "Phone") == nil)
        #expect(!fixture.model.isReadOnly("studio"))
        #expect(fixture.model.isReadOnly("laptop"))
        for session in fixture.sessions.started { session.finishShutdownWhenStopped() }
        await fixture.model.remove("laptop")
        #expect(!fixture.model.isReadOnly("studio"))
        // A relaunch reads the same grants.
        let relaunch = try MachinesFixture(machines: [machine("studio", device: install)], defaults: fixture.defaults)
        await relaunch.model.load()
        #expect(!relaunch.model.isReadOnly("studio"))
    }

    @Test func aGrantSavedByAnOlderBuildStaysWithItsMachine() async throws {
        let suite = "ace.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        // Older builds kept grants by device id alone; each pairing had its own device id then.
        defaults.set(["phone-2": ["read"], "phone-1": ["read", "operate"]], forKey: "ace.machines.grants")
        let fixture = try MachinesFixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")],
                                          defaults: defaults)
        await fixture.model.load()
        // Moved to machine and device, with no device-only entry left to fall back on.
        let saved = defaults.dictionary(forKey: "ace.machines.grants") as? [String: [String]]
        #expect(saved == ["laptop|phone-2": ["read"], "studio|phone-1": ["read", "operate"]])
        #expect(fixture.model.isReadOnly("laptop"))
        #expect(!fixture.model.isReadOnly("studio"))
        // A relaunch reads them by machine.
        let relaunch = try MachinesFixture(machines: [machine("studio", device: "phone-1"), machine("laptop", device: "phone-2")],
                                           defaults: defaults)
        await relaunch.model.load()
        #expect(relaunch.model.isReadOnly("laptop") && !relaunch.model.isReadOnly("studio"))
    }

    @Test func turningOffTheMachinesBehindTheFinishedSummaryRebuildsItAndThenWithdrawsIt() async throws {
        let suite = "ace.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let center = Center()
        let coordinator = NotificationCoordinator(center: center, authorizer: Allowed(), defaults: defaults, now: { 0 },
                                                  connectInBackground: { _ in [] })
        for (host, thread, title) in [("studio", "s1", "Fix stalls"), ("laptop", "l1", "Ship the widget")] {
            await coordinator.desk.land(AlertNotification(id: "a-\(thread)", threadId: thread, title: title, status: "done",
                                                          interactionId: nil, backgroundCount: 0, actions: [], preview: nil, message: nil),
                                        hostId: host)
        }
        #expect(center.delivered[AlertStack.summaryId]?.title == "2 threads finished")

        coordinator.turnedOff("laptop")
        await settle { center.delivered[AlertStack.summaryId]?.title == "1 thread finished" }
        #expect(center.delivered[AlertStack.summaryId]?.body == "Fix stalls")
        // Kept as it now stands, so a relaunch doesn't bring the laptop's finish back.
        #expect(AlertStack.load(defaults).shown.map(\.hostId) == ["studio"])

        coordinator.turnedOff("studio")
        #expect(center.delivered[AlertStack.summaryId] == nil)
        #expect(center.withdrawn.contains(AlertStack.summaryId))
        #expect(AlertStack.load(defaults).shown.isEmpty)
    }

    @Test func clearingTwoMachinesFinishesBackToBackNeverBringsTheWithdrawnSummaryBack() async throws {
        let suite = "ace.tests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let center = Center()
        let coordinator = NotificationCoordinator(center: center, authorizer: Allowed(), defaults: defaults, now: { 0 },
                                                  connectInBackground: { _ in [] })
        for (host, thread, title) in [("studio", "s1", "Fix stalls"), ("laptop", "l1", "Ship the widget")] {
            await coordinator.desk.land(AlertNotification(id: "a-\(thread)", threadId: thread, title: title, status: "done",
                                                          interactionId: nil, backgroundCount: 0, actions: [], preview: nil, message: nil),
                                        hostId: host)
        }
        #expect(center.delivered[AlertStack.summaryId]?.title == "2 threads finished")
        // No yield between them: the first clear's repost must not outlive the second clear.
        coordinator.turnedOff("laptop")
        coordinator.turnedOff("studio")
        for _ in 0..<50 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(20))
        #expect(center.delivered[AlertStack.summaryId] == nil)
        #expect(center.delivered.isEmpty)
    }

    private func machine(_ host: String, device: String) -> MachineEntry {
        MachineEntry(hostId: host, displayName: host.capitalized, icon: nil,
                     target: .init(kind: "direct", url: "wss://100.64.0.7:4243/", fingerprint: DaemonCertificate.pin), deviceId: device)
    }
}

private final class Center: NotificationCenterPort, @unchecked Sendable {
    var withdrawn: [String] = []
    /// What Notification Center shows: a post replaces any with the same identifier.
    var delivered: [String: AlertContent] = [:]
    func post(_ content: AlertContent) async { delivered[content.identifier] = content }
    func withdraw(_ identifiers: [String]) {
        withdrawn.append(contentsOf: identifiers)
        for id in identifiers { delivered.removeValue(forKey: id) }
    }
}
private struct Allowed: NotificationAuthorizer {
    func status() async -> NotificationCoordinator.Permission { .allowed }
    func request() async -> Bool { true }
}

@MainActor private func settle(_ done: () -> Bool) async {
    for _ in 0..<500 where !done() { try? await Task.sleep(for: .milliseconds(2)) }
}
private func row(connection: String, thread: String) -> String {
    let value = #"{"id":"\#(thread)","title":"Thread","state":"done","project":"ace","branch":"","machine":"","provider":"codex","model":"","agents":1,"updatedAt":1,"canSteer":false,"status":{"label":"Done","token":"done"}}"#
    return #"[{"type":"connection","state":"\#(connection)"},{"type":"inbox.reset"},{"type":"inbox.row","id":"\#(thread)","row":\#(value)},{"type":"inbox.sections","sections":[{"key":"done","label":"Done","ids":["\#(thread)"],"ranks":["1"],"order":0}],"more":false,"snooze":[]}]"#
}
