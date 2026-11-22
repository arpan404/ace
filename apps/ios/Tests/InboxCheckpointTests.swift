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
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { _, _, _, _ in session })

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

    /// Holds the studio machine's read until the test lets it finish; others read at once.
    private final class HeldRead: @unchecked Sendable {
        private let lock = NSLock()
        private var waiting: CheckedContinuation<Void, Never>?
        private var released = false
        let started = Answer()
        let held: URL
        init(_ held: URL) { self.held = held }
        var reader: InboxCheckpoint.Reader {
            { [self] database in
                if database == held {
                    started.give("reading")
                    await withCheckedContinuation { continuation in
                        let go = lock.withLock { () -> Bool in
                            if released { return true }
                            waiting = continuation
                            return false
                        }
                        if go { continuation.resume() }
                    }
                }
                return InboxCheckpoint.read(database: database)
            }
        }
        func release() {
            let continuation = lock.withLock { () -> CheckedContinuation<Void, Never>? in
                released = true
                defer { waiting = nil }
                return waiting
            }
            continuation?.resume()
        }
    }
    /// A model whose studio machine has a kept inbox, and whose read of it is held.
    private func heldStudio(in directory: URL) throws -> (ClientModel, HeldRead) {
        let studio = ClientModel.database(hostId: "studio", deviceId: "device", in: directory)
        try InboxCheckpoint.write(try json([
            ["type": "inbox.reset", "ids": ["studio-row"]],
            ["type": "inbox.row", "id": "studio-row", "row": row("studio-row", state: "done", label: "Syncing", token: "neutral")],
        ]), database: studio)
        let held = HeldRead(studio)
        return (ClientModel(now: { 0 }, frames: .immediate, checkpoints: held.reader, makeRuntime: { _, _, _, _ in StartRecorder() }), held)
    }

    @Test func aMachineSwitchedToWhileTheLastOnesCopyIsReadNeverShowsItsRows() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let (model, held) = try heldStudio(in: directory)
        let first = Task { await model.connect(target: try target(host: "studio"), directory: directory) }
        _ = await held.started.value()
        // The person switches machines; that connection finishes while studio's read is held.
        await model.connect(target: try target(host: "laptop"), directory: directory)
        #expect(model.hostId == "laptop")
        held.release()
        try await first.value
        #expect(model.hostId == "laptop")
        #expect(model.inbox["studio-row"] == nil, "another machine's kept rows never show under this one")
    }
    @Test func signingOutWhileTheCopyIsReadLeavesTheInboxEmpty() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let (model, held) = try heldStudio(in: directory)
        let first = Task { await model.connect(target: try target(host: "studio"), directory: directory) }
        _ = await held.started.value()
        await model.disconnectAndWait()
        held.release()
        try await first.value
        #expect(model.inbox.isEmpty, "a machine signed out of shows none of its kept rows")
    }

    @Test func aCopyKeptByAnOlderBuildStillShowsItsRowsMovedOnesIncluded() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = ClientModel.database(hostId: "host", deviceId: "device", in: directory)
        // Written before moved rows carried Open's words, beside a row this build can't read.
        var moved = row("moved", state: "done", label: "Moved to Studio", token: "neutral")
        moved["look"] = ["level": "quiet", "word": "Moved to Studio", "tone": "idle", "muted": true, "settled": false,
                         "subagents": 0, "moved": ["hostId": "studio", "name": "Studio", "threadId": "there"]]
        try InboxCheckpoint.write(try json([
            ["type": "inbox.reset", "ids": ["moved", "done", "odd"]],
            ["type": "inbox.row", "id": "moved", "row": moved],
            ["type": "inbox.row", "id": "odd", "row": ["id": "odd"]],
            ["type": "inbox.row", "id": "done", "row": row("done", state: "done", label: "Done", token: "done")],
        ]), database: database)
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { _, _, _, _ in StartRecorder() })

        await model.connect(target: try target(), directory: directory)

        #expect(model.inbox["moved"]?.look?.moved?.hostId == "studio")
        #expect(model.inbox["done"]?.status.label == "Done")
        #expect(model.inbox["odd"] == nil, "only the row this build can't read is left out")
    }

    @Test func anUnreadableCopyStartsTheInboxEmpty() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = ClientModel.database(hostId: "host", deviceId: "device", in: directory)
        try InboxCheckpoint.write("[{\"type\":\"inbox.row\"", database: database)
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { _, _, _, _ in StartRecorder() })
        await model.connect(target: try target(), directory: directory)
        #expect(model.inbox.isEmpty)
        #expect(!model.inboxLoaded)
    }

    @Test func theSpadeTabShowsOnAColdStartFromItsKeptStateUntilTheMachineSaysSpadeIsGone() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = ClientModel.database(hostId: "host", deviceId: "device", in: directory)
        // As the bridge keeps it (`spade-checkpoint.ts`), with a conversation it never restores.
        let scope = try #require(try target().keptScope)
        try InboxCheckpoint.writeSpade(try json([
            ["type": "spade.state", "shown": true, "line": line, "host": "host",
             "list": ["rows": [bot("Spade", main: true), bot("Research")], "failed": false]],
            ["type": "spade.conversation", "id": "c1", "loaded": true, "answering": true],
        ]), database: database, scope: scope)
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { _, _, _, _ in StartRecorder() })

        await model.connect(target: try target(), directory: directory)

        #expect(model.spade.shown == true)
        #expect(model.spade.bots?.map(\.name) == ["Spade", "Research"])
        #expect(model.spade.bots?.allSatisfy { $0.line == "Checking for changes" && $0.state != "working" } == true)
        #expect(model.spade.conversation == nil)

        // The runtime's first word, before the daemon has said, leaves the tab and its bots.
        model.receive(try json([["type": "spade.state", "shown": NSNull(), "line": line, "list": ["rows": NSNull(), "failed": false]]]))
        #expect(model.spade.shown == true)
        #expect(model.spade.bots?.count == 2)

        model.receive(try json([["type": "spade.state", "shown": false, "line": line, "list": ["rows": NSNull(), "failed": false]]]))
        #expect(model.spade.shown == false)
    }

    @Test func anotherPrincipalsKeptSpadeNeverShowsAndIsRemoved() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let database = ClientModel.database(hostId: "host", deviceId: "device", in: directory)
        // Kept by another account on this phone: the same machine and device, another principal.
        let other = KeptScope.of(principal: KeptScope.account(token: "someone else"), hostId: "host")
        try InboxCheckpoint.writeSpade(try json([
            ["type": "spade.state", "shown": true, "line": line, "list": ["rows": [bot("Private")], "failed": false]],
        ]), database: database, scope: other)
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { _, _, _, _ in StartRecorder() })

        await model.connect(target: try target(), directory: directory)

        #expect(model.spade.shown == nil)
        #expect(model.spade.bots == nil)
        #expect(!FileManager.default.fileExists(atPath: InboxCheckpoint.spadeURL(database: database, scope: other).path))
    }

    @Test func anotherRouteToTheSameMachineKeepsTheSpadeTabWhileItReconnects() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { _, _, _, _ in StartRecorder() })
        await model.connect(target: try target(), directory: directory)
        model.receive(try json([["type": "spade.state", "shown": true, "line": line, "list": ["rows": [bot("Research")], "failed": false]]]))

        await model.connect(target: try target(), directory: directory)

        #expect(model.spade.shown == true)
        #expect(model.spade.bots == nil, "a bot the last runtime confirmed waits to be read again")
    }

    private var line: [String: Any] { ["sentence": "Checking Spade…", "ready": false, "canTurnOn": false] }
    private func bot(_ name: String, main: Bool = false) -> [String: Any] {
        ["id": name, "conversation": "c-\(name)", "name": name, "main": main, "initial": String(name.prefix(1)), "group": NSNull(),
         "faces": [["main": main, "initial": String(name.prefix(1)), "away": false]], "state": "off",
         "line": "Checking for changes", "pinned": false]
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func target(host: String = "host") throws -> ConnectionTarget {
        ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:1")), hostId: host, deviceId: "device", pin: nil,
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
