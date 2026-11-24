import Foundation
import Testing
@testable import Ace

/// A row the current connection hasn't confirmed claims nothing: it draws and speaks Syncing, as
/// the web's unconfirmed card does, until its fresh copy confirms it.
@Suite(.timeLimit(.minutes(1))) @MainActor struct InboxRowSyncingTests {
    @Test func aConfirmedRowHiddenBehindTheReconnectGraceReadsSyncingUntilItsFreshCopyConfirms() async throws {
        let clock = TestClock()
        let scheduler = FakeScheduler(clock: clock)
        let sessions = FakeMachineSessions()
        let model = ClientModel(now: { 0 }, frames: .immediate, schedule: { scheduler.schedule($0, $1) },
                                monotonic: { clock.now }, makeRuntime: sessions.make)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:1")), hostId: "studio", deviceId: "device", pin: nil,
                                      credential: { "{}" })
        await model.connect(target: target, directory: directory)
        let session = try #require(sessions.started.first)
        session.finishShutdownWhenStopped()
        session.emit(try text([["type": "connection", "state": "ready", "generation": 0], finished(generation: 0)]))
        await settle { model.inbox["t1"]?.confirmed == true }
        let confirmed = try #require(model.inbox["t1"])
        #expect(InboxThreadRow.look(of: confirmed).meaning == "Finished")

        // The socket is replaced behind a header that still reads connected.
        session.emit(try text([["type": "connection", "state": "reconnecting", "generation": 1]]))
        await settle { model.connection == "reconnecting" }
        #expect(model.shownConnection == "ready")
        let cached = try #require(model.inbox["t1"])
        let syncing = InboxThreadRow.look(of: cached)
        #expect(syncing.level == "syncing")
        #expect(syncing.word == "Syncing")
        #expect(syncing.mode == "word")
        #expect(syncing.icon == "none")
        #expect(syncing.unread != true)
        let spoken = InboxThreadRow.spoken(cached, syncing, snoozed: false, need: nil)
        #expect(spoken.contains("Syncing"))
        #expect(!spoken.contains("Finished"))

        // Ready again, but only the new generation's own row may say it finished.
        session.emit(try text([["type": "connection", "state": "ready", "generation": 1]]))
        await settle { model.connection == "ready" }
        #expect(InboxThreadRow.look(of: try #require(model.inbox["t1"])).level == "syncing")
        session.emit(try text([finished(generation: 1)]))
        await settle { model.inbox["t1"]?.confirmed == true }
        let fresh = try #require(model.inbox["t1"])
        #expect(InboxThreadRow.look(of: fresh).meaning == "Finished")
        #expect(InboxThreadRow.spoken(fresh, InboxThreadRow.look(of: fresh), snoozed: false, need: nil).contains("Finished"))
        model.disconnect()
        await model.disconnectAndWait()
    }

    @Test func aRowKeptAcrossANewListReadsSyncingAndKeepsWhereItSits() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try frames([["type": "inbox.reset", "ids": ["t1"]], finished(generation: 0, settled: true)]))
        #expect(InboxThreadRow.look(of: try #require(model.inbox["t1"])).meaning == "Finished")

        model.receive(try frames([["type": "inbox.reset", "ids": ["t1"]]]))
        let kept = InboxThreadRow.look(of: try #require(model.inbox["t1"]))
        #expect(kept.level == "syncing")
        #expect(kept.meaning == "Syncing")
        // A settled row stays drawn as settled; it just claims no status.
        #expect(kept.settled)
        #expect(kept.subagents == 0)
    }

    @Test func aSyncingOneLineRowSaysSyncingInsteadOfItsWorkOrItsWakeTime() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try frames([finished(generation: 0, settled: true, pr: 1542)]))
        let confirmed = try #require(model.inbox["t1"])
        let confirmedLook = InboxThreadRow.look(of: confirmed)
        #expect(InboxLineRow.trailing(confirmedLook, row: confirmed, end: .work, wake: nil, dimmed: true) == .work)
        #expect(InboxLineRow.trailing(confirmedLook, row: confirmed, end: .status, wake: nil, dimmed: false) == .mark("done"))

        model.receive(try frames([["type": "connection", "state": "reconnecting", "generation": 1]]))
        let cached = try #require(model.inbox["t1"])
        let look = InboxThreadRow.look(of: cached)
        #expect(InboxLineRow.trailing(look, row: cached, end: .work, wake: nil, dimmed: true) == .syncing)
        #expect(InboxLineRow.trailing(look, row: cached, end: .work, wake: "Until 3:00 PM", dimmed: true) == .syncing)
        #expect(InboxLineRow.trailing(look, row: cached, end: .status, wake: nil, dimmed: false) == .syncing)
    }

    @Test func aSyncingRowsPreviewDropsItsCachedHoverLine() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try frames([finished(generation: 0)]))
        #expect(ThreadPreview.hover(of: try #require(model.inbox["t1"]))?.sentence == "Finished 2m ago")

        model.receive(try frames([["type": "connection", "state": "reconnecting", "generation": 1]]))
        let cached = try #require(model.inbox["t1"])
        #expect(ThreadPreview.hover(of: cached) == nil)
        #expect(InboxThreadRow.look(of: cached).meaning == "Syncing")
    }

    private func finished(generation: Int, settled: Bool = false, pr: Int? = nil) -> [String: Any] {
        var row: [String: Any] = [
            "id": "t1", "title": "Fix login", "state": "done", "project": "ace",
            "branch": "main", "machine": "mbp", "provider": "claude", "model": "opus",
            "agents": 3, "updatedAt": 0, "canSteer": true,
            "status": ["label": "Done", "token": "done"], "confirmed": true, "generation": generation,
            "hover": ["sentence": "Finished 2m ago", "detail": "ran bun test", "code": false, "ink": "muted"],
            "look": ["level": "done-unread", "word": "Done", "tone": "done", "muted": false, "settled": settled,
                     "subagents": 2, "unread": true, "icon": "done", "iconTone": "finished", "mode": "icon",
                     "meaning": "Finished", "state": "finished"],
        ]
        if let pr { row["pr"] = ["number": pr, "state": "open"] }
        return ["type": "inbox.row", "id": "t1", "row": row]
    }
    private func frames(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
    private func text(_ values: [[String: Any]]) throws -> String { String(decoding: try frames(values), as: UTF8.self) }
    private func settle(_ done: () -> Bool) async {
        for _ in 0..<500 where !done() { try? await Task.sleep(for: .milliseconds(2)) }
    }
}
