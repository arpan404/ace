import Foundation
import Testing
@testable import Ace

/// The row rules the lock screen relies on: a cached done row across a reconnect stays Syncing
/// until its snapshot confirms it, and older generations never read as confirmed.
@Suite struct ThreadLiveActivityTests {
    @Test func aCachedDoneRowStaysSyncingUntilItsSnapshotConfirmsIt() throws {
        let cached = try JSONDecoder().decode(ThreadRow.self, from: Data(cachedDoneJSON.utf8))
        #expect(cached.confirmed != true)
        #expect(ThreadLiveActivity.displayLabel(row: cached, online: true) == "Syncing")
        #expect(ThreadLiveActivity.displayToken(row: cached, online: true) == "neutral")
        let confirmed = try JSONDecoder().decode(ThreadRow.self, from: Data(confirmedDoneJSON.utf8))
        #expect(confirmed.confirmed == true)
        #expect(ThreadLiveActivity.displayLabel(row: confirmed, online: true) == "Done")
    }

    @Test func aRowWithoutConfirmationOrGenerationDecodesAsUnconfirmed() throws {
        let row = try JSONDecoder().decode(ThreadRow.self, from: Data(workingJSON.utf8))
        #expect(row.confirmed != true)
        #expect(row.generation == nil)
        #expect(ThreadLiveActivity.displayLabel(row: row, online: true) == "Syncing")
    }

    @Test func anOlderGenerationNeverFinishesEvenWhenMarkedConfirmed() throws {
        let current = try JSONDecoder().decode(ThreadRow.self, from: Data(confirmedDoneGen7JSON.utf8))
        let effectiveCurrent = ThreadLiveActivity.effectiveRow(current, latestGeneration: 7)
        #expect(effectiveCurrent.confirmed == true)
        let stale = try JSONDecoder().decode(ThreadRow.self, from: Data(confirmedDoneGen5JSON.utf8))
        let effectiveStale = ThreadLiveActivity.effectiveRow(stale, latestGeneration: 7)
        #expect(effectiveStale.confirmed != true)
        #expect(ThreadLiveActivity.displayLabel(row: effectiveStale, online: true) == "Syncing")
        let missing = try JSONDecoder().decode(ThreadRow.self, from: Data(confirmedDoneNoGenJSON.utf8))
        let effectiveMissing = ThreadLiveActivity.effectiveRow(missing, latestGeneration: 7)
        #expect(effectiveMissing.confirmed != true)
    }

    @Test @MainActor func aNonreadyTransitionInvalidatesHeldConfirmationAndWelcomeAloneNeverReconfirms() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try frame([[
            "type": "inbox.row", "id": "t1",
            "row": ["id": "t1", "title": "Fix login", "state": "done", "project": "ace",
                    "branch": "main", "machine": "mbp", "provider": "claude", "model": "opus",
                    "agents": 1, "updatedAt": 0, "canSteer": true,
                    "status": ["label": "Done", "token": "done"], "confirmed": true, "generation": 0],
        ]]))
        #expect(model.inbox["t1"]?.confirmed == true)
        model.receive(try frame([["type": "connection", "state": "offline", "generation": 1]]))
        #expect(model.inbox["t1"]?.confirmed != true)
        #expect(model.inbox["t1"]?.state == "done")
        model.receive(try frame([["type": "connection", "state": "ready", "generation": 1]]))
        model.receive(try frame([[
            "type": "inbox.row", "id": "t1",
            "row": ["id": "t1", "title": "Fix login", "state": "working", "project": "ace",
                    "branch": "main", "machine": "mbp", "provider": "claude", "model": "opus",
                    "agents": 1, "updatedAt": 0, "canSteer": true,
                    "status": ["label": "Working", "token": "working"], "confirmed": true, "generation": 1],
        ]]))
        #expect(model.inbox["t1"]?.confirmed == true)
        #expect(model.inbox["t1"]?.state == "working")
    }

    @Test @MainActor func aReadyConnectionBeforeItsRowFramesNeverFinishesOnACachedConfirmation() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try frame([[
            "type": "inbox.row", "id": "t1",
            "row": ["id": "t1", "title": "Fix login", "state": "done", "project": "ace",
                    "branch": "main", "machine": "mbp", "provider": "claude", "model": "opus",
                    "agents": 1, "updatedAt": 0, "canSteer": true,
                    "status": ["label": "Done", "token": "done"], "confirmed": true, "generation": 0],
        ]]))
        #expect(model.inbox["t1"]?.confirmed == true)
        // PatchPump coalesces offline into ready: native sees ready with the advanced fence
        // before the row frames that invalidate it arrive.
        model.receive(try frame([["type": "connection", "state": "ready", "generation": 1]]))
        #expect(model.inbox["t1"]?.confirmed != true)
        #expect(model.inbox["t1"]?.state == "done")
    }

    @Test @MainActor func aRowWithoutAGenerationNeverConfirmsOnceFencingBegins() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try frame([["type": "connection", "state": "ready", "generation": 1]]))
        model.receive(try frame([[
            "type": "inbox.row", "id": "t1",
            "row": ["id": "t1", "title": "Fix login", "state": "done", "project": "ace",
                    "branch": "main", "machine": "mbp", "provider": "claude", "model": "opus",
                    "agents": 1, "updatedAt": 0, "canSteer": true,
                    "status": ["label": "Done", "token": "done"], "confirmed": true],
        ]]))
        #expect(model.inbox["t1"]?.confirmed != true)
    }

    @Test @MainActor func aStaleRowGenerationNeverFinishesEvenWhenMarkedConfirmed() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try frame([["type": "connection", "state": "ready", "generation": 7]]))
        model.receive(try frame([[
            "type": "inbox.row", "id": "t1",
            "row": ["id": "t1", "title": "Fix login", "state": "done", "project": "ace",
                    "branch": "main", "machine": "mbp", "provider": "claude", "model": "opus",
                    "agents": 1, "updatedAt": 0, "canSteer": true,
                    "status": ["label": "Done", "token": "done"], "confirmed": true, "generation": 5],
        ]]))
        let stored = try #require(model.inbox["t1"])
        #expect(stored.confirmed != true)
        #expect(ThreadLiveActivity.displayLabel(row: stored, online: true) == "Syncing")
    }

    @Test @MainActor func aRowWithoutConfirmationPayloadNeverConfirmsOnItsOwnGeneration() throws {
        let model = ClientModel(now: { 0 })
        // No `confirmed` field at all, on the current generation: still unconfirmed.
        model.receive(try frame([[
            "type": "inbox.row", "id": "t1",
            "row": ["id": "t1", "title": "Fix login", "state": "done", "project": "ace",
                    "branch": "main", "machine": "mbp", "provider": "claude", "model": "opus",
                    "agents": 1, "updatedAt": 0, "canSteer": true,
                    "status": ["label": "Done", "token": "done"], "generation": 0],
        ]]))
        #expect(model.inbox["t1"]?.confirmed != true)
    }

    @Test @MainActor func anInboxResetClearsRowsSoAPendingEndCannotCommit() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try frame([[
            "type": "inbox.row", "id": "t1",
            "row": ["id": "t1", "title": "Fix login", "state": "done", "project": "ace",
                    "branch": "main", "machine": "mbp", "provider": "claude", "model": "opus",
                    "agents": 1, "updatedAt": 0, "canSteer": true,
                    "status": ["label": "Done", "token": "done"], "confirmed": true, "generation": 0],
        ]]))
        #expect(model.inbox["t1"]?.confirmed == true)
        // The reset marks the frame dirty, so the activity shell re-reads: the vanished row
        // notes a fresh revision there and any queued end is revoked instead of delivered.
        model.receive(try frame([["type": "inbox.reset"]]))
        #expect(model.inbox.isEmpty)
    }

    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }

    private let workingJSON = """
        {"id":"t1","title":"Fix login","state":"working","project":"ace","branch":"main",\
        "machine":"mbp","provider":"claude","model":"opus","agents":1,"updatedAt":0,\
        "canSteer":true,"status":{"label":"Working","token":"working"}}
        """
    private let cachedDoneJSON = """
        {"id":"t1","title":"Fix login","state":"done","project":"ace","branch":"main",\
        "machine":"mbp","provider":"claude","model":"opus","agents":1,"updatedAt":0,\
        "canSteer":true,"status":{"label":"Done","token":"done"},"confirmed":false,"generation":0}
        """
    private let confirmedDoneJSON = """
        {"id":"t1","title":"Fix login","state":"done","project":"ace","branch":"main",\
        "machine":"mbp","provider":"claude","model":"opus","agents":1,"updatedAt":0,\
        "canSteer":true,"status":{"label":"Done","token":"done"},"confirmed":true,"generation":0}
        """
    private let confirmedWorkingJSON = """
        {"id":"t1","title":"Fix login","state":"working","project":"ace","branch":"main",\
        "machine":"mbp","provider":"claude","model":"opus","agents":1,"updatedAt":0,\
        "canSteer":true,"status":{"label":"Working","token":"working"},"confirmed":true,"generation":0}
        """
    private let cachedWorkingJSON = """
        {"id":"t1","title":"Fix login","state":"working","project":"ace","branch":"main",\
        "machine":"mbp","provider":"claude","model":"opus","agents":1,"updatedAt":0,\
        "canSteer":true,"status":{"label":"Working","token":"working"},"confirmed":false,"generation":0}
        """
    private let confirmedDoneGen7JSON = """
        {"id":"t1","title":"Fix login","state":"done","project":"ace","branch":"main",\
        "machine":"mbp","provider":"claude","model":"opus","agents":1,"updatedAt":0,\
        "canSteer":true,"status":{"label":"Done","token":"done"},"confirmed":true,"generation":7}
        """
    private let confirmedDoneGen5JSON = """
        {"id":"t1","title":"Fix login","state":"done","project":"ace","branch":"main",\
        "machine":"mbp","provider":"claude","model":"opus","agents":1,"updatedAt":0,\
        "canSteer":true,"status":{"label":"Done","token":"done"},"confirmed":true,"generation":5}
        """
    private let confirmedDoneNoGenJSON = """
        {"id":"t1","title":"Fix login","state":"done","project":"ace","branch":"main",\
        "machine":"mbp","provider":"claude","model":"opus","agents":1,"updatedAt":0,\
        "canSteer":true,"status":{"label":"Done","token":"done"},"confirmed":true}
        """
}
