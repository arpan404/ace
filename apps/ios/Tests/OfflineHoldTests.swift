import Foundation
import Testing
@testable import Ace

/// When the runtimes hear the phone went offline.
@Suite struct OfflineHoldTests {
    @Test func aPathThatComesBackInsideTheHoldIsNeverTold() {
        var hold = OfflineHold()
        #expect(hold.path(online: false, at: 1_000) == .check(at: 1_000 + OfflineHold.hold))
        #expect(hold.path(online: true, at: 2_000) == .none)
        #expect(hold.elapsed(at: 1_000 + OfflineHold.hold) == .none)
    }

    @Test func aPathDownPastTheHoldIsToldOfflineThenOnlineAtOnce() {
        var hold = OfflineHold()
        _ = hold.path(online: false, at: 0)
        #expect(hold.path(online: false, at: 1_000) == .check(at: OfflineHold.hold))
        #expect(hold.elapsed(at: OfflineHold.hold - 1) == .check(at: OfflineHold.hold))
        #expect(hold.elapsed(at: OfflineHold.hold) == .tell(online: false))
        #expect(hold.path(online: false, at: 9_000) == .none)
        #expect(hold.path(online: true, at: 10_000) == .tell(online: true))
    }
}

/// What the OS's readings tell the model, before any hold.
@Suite struct NetworkMonitorReadingTests {
    @Test func aFirstReadingWithANetworkIsOnlyABaseline() {
        #expect(NetworkMonitor.change(from: nil, online: true, interfaces: ["en0"]) == nil)
    }

    @Test func aFirstReadingWithNoNetworkIsOfflineNews() {
        #expect(NetworkMonitor.change(from: nil, online: false, interfaces: []) == .init(online: false, interfaceChanged: false))
    }

    @Test func laterReadingsReportOnlyWhatMoved() {
        let baseline = (online: true, interfaces: ["en0"])
        #expect(NetworkMonitor.change(from: baseline, online: true, interfaces: ["en0"]) == nil)
        #expect(NetworkMonitor.change(from: baseline, online: false, interfaces: ["en0"]) == .init(online: false, interfaceChanged: false))
        #expect(NetworkMonitor.change(from: baseline, online: true, interfaces: ["pdp_ip0"]) == .init(online: true, interfaceChanged: true))
    }
}

/// The hold as the machines' runtimes hear it, while the wall clock moves on its own.
@Suite(.timeLimit(.minutes(1))) @MainActor struct OfflineHoldClockTests {
    @Test func aWallClockSetForwardDuringABlipNeverTellsTheRuntimesOfflineEarly() async throws {
        let wall = TestClock()
        let fixture = try MachinesFixture(machines: [studio()], wall: wall)
        defer { fixture.cleanUp() }
        await fixture.model.load()
        let session = try #require(fixture.sessions.started.first)
        session.finishShutdownWhenStopped()

        fixture.model.network(online: false, interfaceChanged: true)
        wall.advance(3_600_000)
        // Another reading while the path is still down, now an hour later by the wall clock.
        fixture.model.network(online: false, interfaceChanged: true)
        #expect(!toldOffline(session))
        fixture.scheduler.advance(OfflineHold.hold)
        #expect(toldOffline(session))
    }

    @Test func aPhoneThatLaunchesWithNoNetworkStartsTheHoldAndTellsTheRuntimeOnceItExpires() async throws {
        let fixture = try MachinesFixture(machines: [studio()])
        defer { fixture.cleanUp() }
        // The monitor's first reading is no network, and it reaches the model before any runtime exists.
        let first = try #require(NetworkMonitor.change(from: nil, online: false, interfaces: []))
        fixture.model.network(online: first.online, interfaceChanged: first.interfaceChanged)
        fixture.scheduler.advance(OfflineHold.hold)
        await fixture.model.load()
        let session = try #require(fixture.sessions.started.first)
        session.finishShutdownWhenStopped()
        #expect(toldOffline(session))
        // Online again at once, for the runtime too.
        fixture.model.network(online: true, interfaceChanged: true)
        #expect(toldOnline(session))
    }

    @Test func aRuntimeThatFinishesOpeningAfterTheHoldExpiredStartsOffline() async throws {
        let fixture = try MachinesFixture(machines: [studio()])
        defer { fixture.cleanUp() }
        let gate = ListGate()
        gate.close()
        let reached = Reached()
        fixture.model.beforeConnect = { _, _ in reached.count += 1; await gate.wait() }
        let loading = Task { await fixture.model.load() }
        await settle { reached.count == 1 }

        // The path drops and stays down while the machine's runtime is still opening.
        fixture.model.network(online: false, interfaceChanged: true)
        fixture.scheduler.advance(OfflineHold.hold)
        #expect(fixture.sessions.started.isEmpty)
        gate.open()
        await loading.value
        let session = try #require(fixture.sessions.started.first)
        session.finishShutdownWhenStopped()
        #expect(toldOffline(session))
    }

    @Test func aRuntimeOpeningWhileThePathIsStillInsideTheHoldIsNotToldOffline() async throws {
        let fixture = try MachinesFixture(machines: [studio()])
        defer { fixture.cleanUp() }
        fixture.model.network(online: false, interfaceChanged: true)
        fixture.scheduler.advance(OfflineHold.hold - 1)
        await fixture.model.load()
        let session = try #require(fixture.sessions.started.first)
        session.finishShutdownWhenStopped()
        #expect(!toldOffline(session))
        fixture.scheduler.advance(1)
        #expect(toldOffline(session))
    }

    private func toldOffline(_ session: FakeMachineSession) -> Bool {
        session.invoked.contains { $0.contains(#""type":"network""#) && $0.contains("false") }
    }
    private func toldOnline(_ session: FakeMachineSession) -> Bool {
        session.invoked.contains { $0.contains(#""type":"network""#) && $0.contains("true") }
    }
    @MainActor private final class Reached { var count = 0 }
    private func settle(_ done: () -> Bool) async {
        for _ in 0..<500 where !done() { try? await Task.sleep(for: .milliseconds(2)) }
    }
    private func studio() -> MachineEntry {
        MachineEntry(hostId: "studio", displayName: "Studio", icon: nil,
                     target: .init(kind: "direct", url: "wss://100.64.0.7:4243/", fingerprint: DaemonCertificate.pin), deviceId: "phone-1")
    }
}
