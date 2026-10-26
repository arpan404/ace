import Foundation
import Testing
@testable import Ace

/// The inbox a launch draws before its runtime starts, and how the runtime's first list replaces
/// it in place. The kept copy is written the way the bridge writes it (`inbox.checkpoint`).
@Suite @MainActor struct InboxCheckpointTests {
    @Test func theLastKnownInboxShowsBeforeTheRuntimeStartsAndNeverReadsAsConfirmed() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = ClientModel.database(hostId: "host", deviceId: "device", in: directory)
        // A kept copy also holding a ready connection: only its inbox is ever restored.
        try InboxCheckpoint.write(try json([
            ["type": "connection", "state": "ready", "generation": 3],
            ["type": "inbox.reset", "ids": ["done", "asking"]],
            ["type": "inbox.row", "id": "done", "row": row("done", state: "done", label: "Syncing", token: "neutral")],
            ["type": "inbox.row", "id": "asking", "row": row("asking", state: "needs_you", label: "Approve", token: "needsYou")],
            sections(["asking", "done"]),
        ]), database: database)
        let session = StartRecorder()
        let model = ClientModel(now: { 0 }, makeRuntime: { _, _, _, _ in session })

        await model.connect(target: try target(), directory: directory)

        #expect(model.inboxLoaded)
        #expect(model.inbox["done"]?.status.label == "Syncing")
        #expect(model.inbox["asking"]?.status.label == "Approve")
        #expect(model.inbox.values.allSatisfy { $0.confirmed != true })
        #expect(model.inboxLayout.sections.flatMap(\.ids) == ["asking", "done"])
        #expect(model.connection == "connecting")
    }

    @Test func theRuntimesFirstListKeepsTheRowsItNamesUntilTheirFreshCopyAndDropsTheRest() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try json([
            ["type": "inbox.reset", "ids": ["kept", "gone"]],
            ["type": "inbox.row", "id": "kept", "row": row("kept", state: "done", label: "Done", token: "done", confirmed: true, generation: 0)],
            ["type": "inbox.row", "id": "gone", "row": row("gone", state: "done", label: "Done", token: "done", confirmed: true, generation: 0)],
        ]))

        // The new list arrives over several frames: its reset first.
        model.receive(try json([["type": "inbox.reset", "ids": ["kept", "new"]]]))
        #expect(model.inbox["gone"] == nil)
        // Still drawn, so the list neither blanks nor jumps, but no longer confirmed.
        #expect(model.inbox["kept"] != nil)
        #expect(model.inbox["kept"]?.confirmed != true)

        model.receive(try json([
            ["type": "inbox.row", "id": "kept", "row": row("kept", state: "working", label: "Working", token: "working", confirmed: true, generation: 0)],
        ]))
        #expect(model.inbox["kept"]?.status.label == "Working")
        #expect(model.inbox["kept"]?.confirmed == true)
    }

    @Test func anUnreadableCopyStartsTheInboxEmpty() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = ClientModel.database(hostId: "host", deviceId: "device", in: directory)
        try InboxCheckpoint.write("[{\"type\":\"inbox.row\"", database: database)
        let model = ClientModel(now: { 0 }, makeRuntime: { _, _, _, _ in StartRecorder() })
        await model.connect(target: try target(), directory: directory)
        #expect(model.inbox.isEmpty)
        #expect(!model.inboxLoaded)
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func target() throws -> ConnectionTarget {
        ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:1")), hostId: "host", deviceId: "device", pin: nil,
                         credential: { "{}" })
    }
    private func json(_ patches: [[String: Any]]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: patches), as: UTF8.self)
    }
    private func json(_ patches: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: patches) }
    private func row(_ id: String, state: String, label: String, token: String, confirmed: Bool = false, generation: Int = 0) -> [String: Any] {
        ["id": id, "title": id, "state": state, "project": "ace", "branch": "", "machine": "", "provider": "codex", "model": "",
         "agents": 1, "updatedAt": 1, "canSteer": false, "status": ["label": label, "token": token],
         "confirmed": confirmed, "generation": generation]
    }
    private func sections(_ ids: [String]) -> [String: Any] {
        ["type": "inbox.sections", "sections": [["key": "now", "label": "Now", "ids": ids, "ranks": ids.map { "r-\($0)" }, "order": 0]],
         "more": false, "snooze": []]
    }
}

private final class StartRecorder: ClientSession, @unchecked Sendable {
    func start(itemLimit: Int) {}
    func invoke(_ name: String, json: String) {}
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { completion() }
}
