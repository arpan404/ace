import Foundation
import Testing
@testable import Ace

/// Explicit bounded snapshot begin/commit for warm diffs and cold resets.
/// Staging keeps the last coherent display; only a matching ready fence commits.
@Suite @MainActor struct SnapshotTransactionTests {
    @Test func warmBeginKeepsOldRowsUntilMatchingReadyCommits() throws {
        let model = ClientModel(now: { 0 })
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        let reset: [String: Any] = ["type": "thread.reset", "threadId": "thread", "epoch": epoch, "revision": 1]
        let ready1: [String: Any] = ["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 1, "revision": 1]
        model.receive(try frame([reset, item("old", thread: "thread", epoch: epoch, index: 0), ready1]))
        let shown = try #require(model.thread)
        #expect(shown.order == ["old"])
        #expect(shown.loaded)
        // Warm pass begins: old stays visible. The ledger suppresses unchanged rows,
        // so only the changed row plus the old row's removal travel.
        let begin: [String: Any] = ["type": "thread.snapshot.begin", "threadId": "thread", "epoch": epoch, "revision": 2]
        model.receive(try frame([begin]))
        #expect(shown.order == ["old"])
        model.receive(try frame([item("new", thread: "thread", epoch: epoch, index: 0)]))
        model.receive(try frame([[
            "type": "thread.item", "threadId": "thread", "epoch": epoch, "id": "old",
            "row": NSNull(), "seq": 10, "reason": "deleted",
        ]]))
        #expect(shown.order == ["old"], "staging must not show")
        #expect(shown.requiresSnapshot)
        // Stale fence from the previous revision cannot commit the new staging.
        let stale: [String: Any] = ["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 1, "revision": 1]
        model.receive(try frame([stale]))
        #expect(shown.order == ["old"])
        #expect(shown.requiresSnapshot)
        // Matching fence commits atomically.
        let ready2: [String: Any] = ["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 1, "revision": 2]
        model.receive(try frame([ready2]))
        #expect(shown.order == ["new"])
        #expect(shown.items["old"] == nil)
        #expect(!shown.requiresSnapshot)
        #expect(shown.loaded)
    }

    @Test func warmUnchangedHistoryCommitsWithoutResendingRows() throws {
        // The ledger suppresses every unchanged row: only begin + ready travel.
        // Seeding keeps the visible copy, so the fence still matches.
        let model = ClientModel(now: { 0 })
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        model.receive(try frame([
            ["type": "thread.reset", "threadId": "thread", "epoch": epoch, "revision": 1],
            item("a", thread: "thread", epoch: epoch, index: 0, seq: 10),
            item("b", thread: "thread", epoch: epoch, index: 1, seq: 11),
            ["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 2, "revision": 1],
        ]))
        let shown = try #require(model.thread)
        let keptA = try #require(shown.items["a"])
        model.receive(try frame([["type": "thread.snapshot.begin", "threadId": "thread", "epoch": epoch, "revision": 2]]))
        #expect(shown.order == ["a", "b"])
        model.receive(try frame([["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 2, "revision": 2]]))
        #expect(shown.order == ["a", "b"])
        #expect(shown.items["a"] === keptA, "warm commit preserves row identity")
        #expect(!shown.requiresSnapshot)
    }

    @Test func newerBeginCancelsOlderStaging() throws {
        let model = ClientModel(now: { 0 })
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        model.receive(try frame([
            ["type": "thread.reset", "threadId": "thread", "epoch": epoch, "revision": 1],
            item("a", thread: "thread", epoch: epoch, index: 0),
            ["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 1, "revision": 1],
        ]))
        let shown = try #require(model.thread)
        model.receive(try frame([["type": "thread.snapshot.begin", "threadId": "thread", "epoch": epoch, "revision": 2]]))
        model.receive(try frame([item("b", thread: "thread", epoch: epoch, index: 0)]))
        // A newer snapshot supersedes the old one before it commits.
        model.receive(try frame([["type": "thread.snapshot.begin", "threadId": "thread", "epoch": epoch, "revision": 3]]))
        model.receive(try frame([item("c", thread: "thread", epoch: epoch, index: 0)]))
        model.receive(try frame([["type": "thread.item", "threadId": "thread", "epoch": epoch, "id": "a", "row": NSNull()]]))
        model.receive(try frame([["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 1, "revision": 2]]))
        #expect(shown.order == ["a"], "old fence cannot commit superseded staging")
        model.receive(try frame([["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 1, "revision": 3]]))
        #expect(shown.order == ["c"])
    }

    @Test func stagingNeverShowsStaleDone() throws {
        let model = ClientModel(now: { 0 })
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        model.receive(try frame([
            ["type": "thread.reset", "threadId": "thread", "epoch": epoch, "revision": 1],
            item("a", thread: "thread", epoch: epoch, index: 0),
            ["type": "thread.metadata", "threadId": "thread", "epoch": epoch,
             "row": row(label: "Done", token: "done")],
            ["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 1, "revision": 1],
        ]))
        let shown = try #require(model.thread)
        #expect(model.headerStatus(of: shown)?.label == "Done")
        model.receive(try frame([["type": "thread.snapshot.begin", "threadId": "thread", "epoch": epoch, "revision": 2]]))
        // While staging, cached Done is not authoritative.
        #expect(model.headerStatus(of: shown)?.label == "Syncing")
        model.receive(try frame([
            ["type": "thread.metadata", "threadId": "thread", "epoch": epoch,
             "row": row(label: "Working", token: "working")],
            ["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 1, "revision": 2],
        ]))
        #expect(model.headerStatus(of: shown)?.label == "Working", "confirmed metadata replaces stale Done after commit")
    }

    @Test func removalCarriesSequenceAndReasonForSuccessor() throws {
        let model = ClientModel(now: { 0 })
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        model.receive(try frame([
            ["type": "thread.reset", "threadId": "thread", "epoch": epoch, "revision": 1],
            item("a", thread: "thread", epoch: epoch, index: 0, seq: 10),
            item("b", thread: "thread", epoch: epoch, index: 1, seq: 11),
            ["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 2, "revision": 1],
        ]))
        let shown = try #require(model.thread)
        model.receive(try frame([[
            "type": "thread.item", "threadId": "thread", "epoch": epoch, "id": "a",
            "row": NSNull(), "seq": 10, "reason": "deleted",
        ]]))
        #expect(shown.order == ["b"])
        #expect(shown.recentRemovals.map(\.id) == ["a"])
        #expect(shown.recentRemovals.first?.seq == 10)
        #expect(shown.recentRemovals.first?.reason == "deleted")
    }

    @Test func mismatchedFenceRetriesOnceThenFailsVisibly() throws {
        let model = ClientModel(now: { 0 })
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        model.receive(try frame([
            ["type": "thread.reset", "threadId": "thread", "epoch": epoch, "revision": 1],
            item("a", thread: "thread", epoch: epoch, index: 0),
            ["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 1, "revision": 1],
        ]))
        let shown = try #require(model.thread)
        #expect(shown.order == ["a"])
        // First mismatched fence: old display preserved, silent single retry reopens cold.
        model.receive(try frame([["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 9, "revision": 1]]))
        #expect(shown.order == ["a"], "old display preserved during retry")
        #expect(model.error == nil, "first failure retries silently")
        let retriedEpoch = try #require(model.thread?.epoch)
        #expect(retriedEpoch != epoch, "retry reopens under a new epoch")
        // Second consecutive mismatch: explicit failed-sync error, no further loop.
        model.receive(try frame([
            ["type": "thread.reset", "threadId": "thread", "epoch": retriedEpoch, "revision": 1],
            ["type": "thread.ready", "threadId": "thread", "epoch": retriedEpoch, "count": 9, "revision": 1],
        ]))
        #expect(shown.order == ["a"])
        #expect(model.error == "The conversation could not be synced. Retry the connection.")
    }

    private func row(label: String, token: String) -> [String: Any] {
        ["id": "thread", "title": "T", "state": token, "project": "p", "branch": "", "machine": "m", "provider": "codex",
         "model": "x", "agents": 1, "updatedAt": 0, "canSteer": false, "status": ["label": label, "token": token]]
    }
    private func item(_ id: String, thread: String, epoch: Int, index: Int, seq: Int? = nil) -> [String: Any] {
        var row: [String: Any] = ["id": id, "index": index, "type": "message", "role": "user", "text": "Go",
                                  "complete": true, "createdAt": 0, "agentId": "root", "truncated": false]
        if let seq { row["creationSeq"] = seq }
        return ["type": "thread.item", "threadId": thread, "epoch": epoch, "id": id, "row": row]
    }
    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
}
