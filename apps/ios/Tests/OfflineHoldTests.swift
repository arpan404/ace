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

    private func toldOffline(_ session: FakeMachineSession) -> Bool {
        session.invoked.contains { $0.contains(#""type":"network""#) && $0.contains("false") }
    }
    private func studio() -> MachineEntry {
        MachineEntry(hostId: "studio", displayName: "Studio", icon: nil,
                     target: .init(kind: "direct", url: "wss://100.64.0.7:4243/", fingerprint: DaemonCertificate.pin), deviceId: "phone-1")
    }
}
