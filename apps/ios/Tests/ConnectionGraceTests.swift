import Foundation
import Testing
@testable import Ace

/// What the screens say while a connection that was working is replaced: nothing, for a few
/// seconds, and then the truth.
@Suite(.timeLimit(.minutes(1))) @MainActor struct ConnectionGraceTests {
    @Test func aReconnectThatSucceedsInsideTheGraceIsNeverShown() {
        var grace = ConnectionGrace()
        _ = grace.changed("ready", at: 0)
        // A Wi-Fi to cellular change replaces the socket.
        #expect(grace.changed("reconnecting", at: 1_000) == 1_000 + ConnectionGrace.grace)
        #expect(grace.shown == "ready")
        #expect(grace.changed("connecting", at: 2_000) == 1_000 + ConnectionGrace.grace)
        #expect(grace.shown == "ready")
        #expect(grace.changed("ready", at: 3_000) == nil)
        #expect(grace.shown == "ready")
    }

    @Test func aFailedSilentReconnectShowsReconnectingOnceTheGraceRunsOut() {
        var grace = ConnectionGrace()
        _ = grace.changed("ready", at: 0)
        _ = grace.changed("reconnecting", at: 1_000)
        grace.elapsed(at: 1_000 + ConnectionGrace.grace - 1)
        #expect(grace.shown == "ready")
        grace.elapsed(at: 1_000 + ConnectionGrace.grace)
        #expect(grace.shown == "reconnecting")
        // From then on every real state shows, until the connection is ready again.
        #expect(grace.changed("offline", at: 9_000) == nil)
        #expect(grace.shown == "offline")
    }

    @Test func aBriefNetworkDropIsHiddenButALongOneShowsOffline() {
        var grace = ConnectionGrace()
        _ = grace.changed("ready", at: 0)
        _ = grace.changed("offline", at: 100)
        #expect(grace.shown == "ready")
        grace.elapsed(at: 100 + ConnectionGrace.grace)
        #expect(grace.shown == "offline")
    }

    @Test func aRefusalShowsAtOnce() {
        var grace = ConnectionGrace()
        _ = grace.changed("ready", at: 0)
        _ = grace.changed("reconnecting", at: 1_000)
        #expect(grace.changed("fatal", at: 1_500) == nil)
        #expect(grace.shown == "fatal")
    }

    @Test func aMachineNeverConnectedShowsItsRealStateFromTheStart() {
        var grace = ConnectionGrace()
        #expect(grace.changed("reconnecting", at: 0) == nil)
        #expect(grace.shown == "reconnecting")
    }

    @Test func eachDropGetsItsOwnGrace() {
        var grace = ConnectionGrace()
        _ = grace.changed("ready", at: 0)
        _ = grace.changed("reconnecting", at: 1_000)
        _ = grace.changed("ready", at: 2_000)
        #expect(grace.changed("reconnecting", at: 20_000) == 20_000 + ConnectionGrace.grace)
        grace.elapsed(at: 20_000 + ConnectionGrace.grace - 1)
        #expect(grace.shown == "ready")
    }

    @Test func aLookBeforeTheGraceEndsAsksToLookAgainAtTheSameDeadline() {
        var grace = ConnectionGrace()
        _ = grace.changed("ready", at: 0)
        _ = grace.changed("reconnecting", at: 1_000)
        #expect(grace.elapsed(at: 1_000 + ConnectionGrace.grace - 50) == 1_000 + ConnectionGrace.grace)
        #expect(grace.shown == "ready")
        #expect(grace.elapsed(at: 1_000 + ConnectionGrace.grace) == nil)
        #expect(grace.shown == "reconnecting")
    }

    /// Back from suspension the socket is found dead and replaced: the header keeps the last
    /// state and the runtime reconnects behind it, but nothing that acts reads it as ready.
    @Test func returningFromSuspensionShowsTheLastStateAndReconnectsSilently() async throws {
        let clock = TestClock()
        let scheduler = FakeScheduler(clock: clock)
        let (model, session, directory) = try await connected(clock: clock, schedule: { scheduler.schedule($0, $1) })
        defer { try? FileManager.default.removeItem(at: directory) }

        session.emit(#"[{"type":"connection","state":"reconnecting"}]"#)
        await settle { model.connection == "reconnecting" }
        #expect(model.shownConnection == "ready")
        scheduler.advance(ConnectionGrace.grace - 1)
        #expect(model.shownConnection == "ready")
        session.emit(#"[{"type":"connection","state":"ready"}]"#)
        await settle { model.connection == "ready" }
        #expect(model.shownConnection == "ready")

        // The next drop doesn't come back: past the grace the header says so.
        session.emit(#"[{"type":"connection","state":"reconnecting"}]"#)
        await settle { model.connection == "reconnecting" }
        scheduler.advance(ConnectionGrace.grace)
        #expect(model.shownConnection == "reconnecting")
        model.disconnect()
        await model.disconnectAndWait()
    }

    /// A timer can wake a little before its deadline: the grace looks again then, never leaving
    /// the header on "connected" for a connection that isn't back.
    @Test func aGraceTimerThatFiresEarlyIsArmedAgainAndTheRealStateShowsAtTheDeadline() async throws {
        let clock = TestClock()
        var jobs: [@MainActor () -> Void] = []
        let (model, session, directory) = try await connected(clock: clock, schedule: { _, work in jobs.append(work); return {} })
        defer { try? FileManager.default.removeItem(at: directory) }

        session.emit(#"[{"type":"connection","state":"reconnecting"}]"#)
        await settle { model.connection == "reconnecting" }
        #expect(jobs.count == 1)
        clock.advance(ConnectionGrace.grace - 100)
        jobs[0]()
        #expect(model.shownConnection == "ready")
        #expect(jobs.count == 2)
        clock.advance(100)
        jobs[1]()
        #expect(model.shownConnection == "reconnecting")
        model.disconnect()
        await model.disconnectAndWait()
    }

    /// The wall clock can be set back (by the network's time, or by hand) while a reconnect is
    /// hidden: the grace counts on a clock that never moves back.
    @Test func aWallClockSetBackDuringAReconnectNeverStretchesTheGrace() async throws {
        let clock = TestClock()
        let wall = TestClock()
        let scheduler = FakeScheduler(clock: clock)
        let (model, session, directory) = try await connected(clock: clock, wall: wall, schedule: { scheduler.schedule($0, $1) })
        defer { try? FileManager.default.removeItem(at: directory) }

        session.emit(#"[{"type":"connection","state":"reconnecting"}]"#)
        await settle { model.connection == "reconnecting" }
        wall.advance(-3_600_000)
        scheduler.advance(ConnectionGrace.grace)
        #expect(model.shownConnection == "reconnecting")
        model.disconnect()
        await model.disconnectAndWait()
    }

    /// A model on a fake runtime that has reached ready, its grace counting on `clock` and its
    /// timestamps on `wall`.
    private func connected(clock: TestClock, wall: TestClock = TestClock(), schedule: @escaping RouteScheduler) async throws
        -> (ClientModel, FakeMachineSession, URL) {
        let sessions = FakeMachineSessions()
        let model = ClientModel(now: { wall.now }, frames: .immediate, schedule: schedule, monotonic: { clock.now },
                                makeRuntime: sessions.make)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:1")), hostId: "studio", deviceId: "device", pin: nil,
                                      credential: { "{}" })
        await model.connect(target: target, directory: directory)
        let session = try #require(sessions.started.first)
        session.finishShutdownWhenStopped()
        session.emit(#"[{"type":"connection","state":"ready"}]"#)
        await settle { model.connection == "ready" }
        #expect(model.shownConnection == "ready")
        return (model, session, directory)
    }

    private func settle(_ done: () -> Bool) async {
        for _ in 0..<500 where !done() { try? await Task.sleep(for: .milliseconds(2)) }
    }
}
