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

    private func machine(_ host: String, device: String) -> MachineEntry {
        MachineEntry(hostId: host, displayName: host.capitalized, icon: nil,
                     target: .init(kind: "direct", url: "wss://100.64.0.7:4243/", fingerprint: DaemonCertificate.pin), deviceId: device)
    }
}

private final class Center: NotificationCenterPort, @unchecked Sendable {
    var withdrawn: [String] = []
    func post(_ content: AlertContent) async {}
    func withdraw(_ identifiers: [String]) { withdrawn.append(contentsOf: identifiers) }
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
