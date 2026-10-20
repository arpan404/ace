import Foundation
import Testing
@testable import Ace

/// The Live Activity freshness policy: unchanged canonical rows still renew `staleDate`,
/// and only a freshly confirmed canonical done row while online ever ends its activity.
/// A cached done row across a reconnect stays Syncing until its snapshot confirms it,
/// older generations never finish, and a queued end is revoked by a newer revision.
@Suite struct ThreadLiveActivityTests {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    @Test func aFirstSightingRefreshesAtOnce() {
        #expect(ThreadLiveActivity.shouldRefresh(last: nil, key: "Working", now: t0, renewalInterval: 30))
    }

    @Test func aChangedCanonicalStatusRefreshesBeforeTheIntervalPasses() {
        let last = (key: "Working", refreshedAt: t0)
        #expect(ThreadLiveActivity.shouldRefresh(last: last, key: "Approve", now: t0.addingTimeInterval(5), renewalInterval: 30))
    }

    @Test func anUnchangedRowWaitsOutTheRenewalInterval() {
        let last = (key: "Working", refreshedAt: t0)
        #expect(!ThreadLiveActivity.shouldRefresh(last: last, key: "Working", now: t0.addingTimeInterval(29), renewalInterval: 30))
    }

    @Test func anUnchangedRowRenewsOnceTheIntervalPasses() {
        let last = (key: "Working", refreshedAt: t0)
        #expect(ThreadLiveActivity.shouldRefresh(last: last, key: "Working", now: t0.addingTimeInterval(30), renewalInterval: 30))
    }

    @Test func onlyAFreshlyConfirmedCanonicalDoneRowWhileOnlineEndsItsActivity() {
        #expect(ThreadLiveActivity.shouldEnd(state: "done", online: true, confirmed: true))
        #expect(!ThreadLiveActivity.shouldEnd(state: "done", online: true, confirmed: false))
        #expect(!ThreadLiveActivity.shouldEnd(state: "done", online: true, confirmed: nil))
        #expect(!ThreadLiveActivity.shouldEnd(state: "done", online: false, confirmed: true))
        #expect(!ThreadLiveActivity.shouldEnd(state: "done", online: false, confirmed: false))
        #expect(!ThreadLiveActivity.shouldEnd(state: "working", online: true, confirmed: true))
        #expect(!ThreadLiveActivity.shouldEnd(state: "working", online: false, confirmed: true))
    }

    @Test func aCachedDoneRowStaysSyncingUntilItsSnapshotConfirmsIt() throws {
        let cached = try JSONDecoder().decode(ThreadRow.self, from: Data(cachedDoneJSON.utf8))
        #expect(cached.confirmed != true)
        #expect(ThreadLiveActivity.displayLabel(row: cached, online: true) == "Syncing")
        #expect(ThreadLiveActivity.displayToken(row: cached, online: true) == "neutral")
        #expect(!ThreadLiveActivity.shouldEnd(state: cached.state, online: true, confirmed: cached.confirmed))
        let confirmed = try JSONDecoder().decode(ThreadRow.self, from: Data(confirmedDoneJSON.utf8))
        #expect(confirmed.confirmed == true)
        #expect(ThreadLiveActivity.displayLabel(row: confirmed, online: true) == "Done")
        #expect(ThreadLiveActivity.shouldEnd(state: confirmed.state, online: true, confirmed: confirmed.confirmed))
    }

    @Test func theDedupKeyIncludesConfirmationSoAWelcomeCannotResurrectACachedDone() throws {
        let confirmed = try JSONDecoder().decode(ThreadRow.self, from: Data(confirmedWorkingJSON.utf8))
        let online = ThreadLiveActivity.key(row: confirmed, online: true)
        #expect(ThreadLiveActivity.key(row: confirmed, online: true) == online)
        #expect(ThreadLiveActivity.key(row: confirmed, online: false) != online)
        let renamed = try JSONDecoder().decode(ThreadRow.self, from: Data(confirmedWorkingJSON.replacingOccurrences(of: "Fix login", with: "Fix logout").utf8))
        #expect(ThreadLiveActivity.key(row: renamed, online: true) != online)
        let staleCopy = try JSONDecoder().decode(ThreadRow.self, from: Data(cachedWorkingJSON.utf8))
        #expect(staleCopy.title == confirmed.title)
        #expect(staleCopy.status == confirmed.status)
        #expect(ThreadLiveActivity.key(row: staleCopy, online: true) != online)
    }

    @Test func aRowWithoutConfirmationOrGenerationDecodesAsUnconfirmed() throws {
        let row = try JSONDecoder().decode(ThreadRow.self, from: Data(workingJSON.utf8))
        #expect(row.confirmed != true)
        #expect(row.generation == nil)
        #expect(ThreadLiveActivity.displayLabel(row: row, online: true) == "Syncing")
        #expect(!ThreadLiveActivity.shouldEnd(state: row.state, online: true, confirmed: row.confirmed))
    }

    @Test func anOlderGenerationNeverFinishesEvenWhenMarkedConfirmed() throws {
        let current = try JSONDecoder().decode(ThreadRow.self, from: Data(confirmedDoneGen7JSON.utf8))
        let effectiveCurrent = ThreadLiveActivity.effectiveRow(current, latestGeneration: 7)
        #expect(effectiveCurrent.confirmed == true)
        #expect(ThreadLiveActivity.shouldEnd(state: effectiveCurrent.state, online: true, confirmed: effectiveCurrent.confirmed))
        let stale = try JSONDecoder().decode(ThreadRow.self, from: Data(confirmedDoneGen5JSON.utf8))
        let effectiveStale = ThreadLiveActivity.effectiveRow(stale, latestGeneration: 7)
        #expect(effectiveStale.confirmed != true)
        #expect(ThreadLiveActivity.displayLabel(row: effectiveStale, online: true) == "Syncing")
        #expect(!ThreadLiveActivity.shouldEnd(state: effectiveStale.state, online: true, confirmed: effectiveStale.confirmed))
        let missing = try JSONDecoder().decode(ThreadRow.self, from: Data(confirmedDoneNoGenJSON.utf8))
        let effectiveMissing = ThreadLiveActivity.effectiveRow(missing, latestGeneration: 7)
        #expect(effectiveMissing.confirmed != true)
        #expect(!ThreadLiveActivity.shouldEnd(state: effectiveMissing.state, online: true, confirmed: effectiveMissing.confirmed))
    }

    @Test func aQueuedEndIsRevokedOnceANewerRevisionLands() {
        var gate = LiveActivityCommitGate()
        let pendingEnd = gate.note(id: "activity")
        #expect(gate.shouldCommit(id: "activity", revision: pendingEnd))
        let working = gate.note(id: "activity")
        #expect(!gate.shouldCommit(id: "activity", revision: pendingEnd))
        #expect(gate.shouldCommit(id: "activity", revision: working))
    }

    @Test func aQueuedEndIsRevokedByDisconnectWhileAnotherActivityProceeds() {
        var gate = LiveActivityCommitGate()
        let first = gate.note(id: "t1")
        let second = gate.note(id: "t2")
        _ = gate.note(id: "t1")
        #expect(!gate.shouldCommit(id: "t1", revision: first))
        #expect(gate.shouldCommit(id: "t2", revision: second))
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
        #expect(model.inbox["t1"]?.confirmed != true)
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
        #expect(!ThreadLiveActivity.shouldEnd(state: model.inbox["t1"]?.state ?? "", online: true, confirmed: model.inbox["t1"]?.confirmed))
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
        #expect(!ThreadLiveActivity.shouldEnd(state: "done", online: true, confirmed: model.inbox["t1"]?.confirmed))
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
        #expect(!ThreadLiveActivity.shouldEnd(state: "done", online: true, confirmed: stored.confirmed))
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
        #expect(!ThreadLiveActivity.shouldEnd(state: "done", online: true, confirmed: model.inbox["t1"]?.confirmed))
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
