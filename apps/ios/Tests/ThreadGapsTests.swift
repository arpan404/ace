import Foundation
import Testing
@testable import Ace

/// Going back from a child thread, view-only machines on the new request cards and composer
/// controls, and the steps a settled log reads. Native models only; the bridge is recorded.
@Suite @MainActor struct ThreadGapsTests {
    @Test func backFromAChildKeepsTheParentsTranscriptUntilItsReopenedSessionsFirstBlock() throws {
        let model = ClientModel(now: { 0 })
        model.open("parent")
        model.receive(try frame([
            ["type": "thread.reset", "threadId": "parent", "epoch": 1],
            item("ask", thread: "parent", epoch: 1, index: 0),
            block("turn", thread: "parent", epoch: 1, items: ["ask"], index: 0),
        ]))
        model.open("child")
        model.receive(try frame([block("child-turn", thread: "child", epoch: 2, items: [], index: 0)]))
        #expect(model.thread?.placeholder == nil)
        model.open("parent")
        // Nothing of the reopened session yet: the parent's last blocks and items stay on screen.
        let shown = try #require(model.thread?.placeholder)
        #expect(shown.screen.blockOrder == ["turn"])
        #expect(shown.items["ask"] != nil)
        #expect(model.thread?.screen.blockOrder.isEmpty == true)
        // Late patches from the first visit are still rejected, and change nothing shown.
        model.receive(try frame([block("late", thread: "parent", epoch: 1, items: [], index: 1)]))
        #expect(model.thread?.screen.blocks["late"] == nil)
        #expect(model.thread?.placeholder?.screen.blocks["late"] == nil)
        // The reset alone would flash empty; the placeholder holds until the first block.
        model.receive(try frame([["type": "thread.reset", "threadId": "parent", "epoch": 3], item("ask", thread: "parent", epoch: 3, index: 0)]))
        #expect(model.thread?.placeholder != nil)
        model.receive(try frame([block("turn", thread: "parent", epoch: 3, items: ["ask"], index: 0)]))
        #expect(model.thread?.placeholder == nil)
        #expect(model.thread?.screen.blockOrder == ["turn"])
    }
    @Test func aThreadOpenedFromTheInboxNeverShowsAnotherThreadsPlaceholder() throws {
        let model = ClientModel(now: { 0 })
        model.open("parent")
        model.receive(try frame([block("turn", thread: "parent", epoch: 1, items: [], index: 0)]))
        model.back()
        model.open("parent")
        #expect(model.thread?.placeholder == nil)
        model.open("other")
        model.open("third")
        #expect(model.thread?.placeholder == nil)
    }
    @Test func aViewOnlyMachineSendsNoPlanFormEffortAttachmentOrQueueChange() async throws {
        let (model, session) = try await connected()
        model.canOperate = false
        let plan = ApprovalRow(id: "plan", kind: "plan_review", state: "pending", title: "", description: "", command: "", options: [], truncated: false)
        model.resolve(plan, answer: ["kind": "plan", "decision": "approve"])
        #expect(model.approvalSubmissions["plan"] == nil)
        #expect(await model.setEffort("high") == false)
        #expect(await model.setSpeed("fast") == false)
        model.attach(StagedAttachment(localId: UUID().uuidString, name: "a.png", mimeType: "image/png", bytes: 1, sha256: String(repeating: "a", count: 64)))
        let queued = QueueRow.Message(id: "q", text: "Later", delivery: "queue", state: "queued", attachments: 0)
        #expect(await model.moveQueued(queued, step: 1) == false)
        #expect(session.threadActions.isEmpty)
        model.canOperate = true
        model.resolve(plan, answer: ["kind": "plan", "decision": "approve"])
        #expect(model.approvalSubmissions["plan"]?.phase == .saving)
        #expect(session.threadActions.map { $0["type"] as? String } == ["resolve"])
    }
    @Test func aStopTheDaemonRefusesWhileTheTreeKeepsWorkingCanBeSentAgain() async throws {
        let (model, session) = try await connected()
        let busy: [String: Any] = ["type": "thread.controls", "threadId": "thread", "epoch": 1,
                                   "row": ["busy": true, "delivery": "queue", "alternate": NSNull(), "canStop": true, "provider": "codex", "model": "", "switching": ""]]
        model.receive(try frame([busy]))
        model.stopTree()
        let first = try await stopRequest(session, count: 1)
        model.receive(try frame([["type": "admission", "id": first, "ok": true, "message": ""]]))
        model.receive(try frame([["type": "receipt", "id": first, "ok": false, "message": "Thread is busy"], busy]))
        #expect(model.error == "Thread is busy")
        #expect(model.thread?.screen.stopping == false)
        // Stop is offered again; a late result of the refused one never clears the newer Stop.
        model.stopTree()
        #expect(model.thread?.screen.stopping == true)
        let second = try await stopRequest(session, count: 2)
        #expect(second != first)
        model.receive(try frame([["type": "receipt", "id": first, "ok": false, "message": "Thread is busy"]]))
        #expect(model.thread?.screen.stopping == true)
        model.receive(try frame([["type": "admission", "id": second, "ok": true, "message": ""], ["type": "receipt", "id": second, "ok": true, "message": ""]]))
        #expect(model.thread?.screen.stopping == true)
    }
    @Test func anOpenedLogsStepsAssembleInPageOrderAndDropPagesPastTheHeader() throws {
        let model = ClientModel(now: { 0 })
        model.open("a")
        model.receive(try frame([
            ["type": "thread.stepsPage", "threadId": "a", "epoch": 1, "ordinal": 2, "page": 1, "rows": [step("s2")]],
            ["type": "thread.stepsPage", "threadId": "a", "epoch": 1, "ordinal": 2, "page": 0, "rows": [step("s0"), step("s1")]],
            ["type": "thread.steps", "threadId": "a", "epoch": 1, "ordinal": 2, "state": "ready", "pages": 2, "count": 3, "more": false],
        ]))
        #expect(model.thread?.screen.steps[2]?.rows.map(\.id) == ["s0", "s1", "s2"])
        model.receive(try frame([["type": "thread.steps", "threadId": "a", "epoch": 1, "ordinal": 2, "state": "ready", "pages": 1, "count": 2, "more": true]]))
        #expect(model.thread?.screen.steps[2]?.rows.map(\.id) == ["s0", "s1"])
        model.receive(try frame([["type": "thread.stepsPage", "threadId": "a", "epoch": 0, "ordinal": 2, "page": 0, "rows": [step("stale")]]]))
        #expect(model.thread?.screen.steps[2]?.rows.map(\.id) == ["s0", "s1"])
    }

    private func connected() async throws -> (ClientModel, ThreadActionRecorder) {
        let session = ThreadActionRecorder()
        let model = ClientModel(now: { 0 }, makeRuntime: { _, _, _, _ in session })
        let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:1")), hostId: "host", deviceId: "device", pin: nil, credential: { "{}" })
        await model.connect(target: target, directory: FileManager.default.temporaryDirectory)
        model.open("thread")
        return (model, session)
    }
    /// The request id of the `count`th Stop the bridge received.
    private func stopRequest(_ session: ThreadActionRecorder, count: Int) async throws -> String {
        for _ in 0..<50 where session.threadActions.filter({ $0["type"] as? String == "stop" }).count < count { await Task.yield() }
        let stops = session.threadActions.filter { $0["type"] as? String == "stop" }
        try #require(stops.count == count)
        return try #require(stops.last?["requestId"] as? String)
    }
    private func item(_ id: String, thread: String, epoch: Int, index: Int) -> [String: Any] {
        ["type": "thread.item", "threadId": thread, "epoch": epoch, "id": id,
         "row": ["id": id, "index": index, "type": "message", "role": "user", "text": "Go", "complete": true, "createdAt": 0, "agentId": "root", "truncated": false]]
    }
    private func block(_ id: String, thread: String, epoch: Int, items: [String], index: Int) -> [String: Any] {
        ["type": "thread.block", "threadId": thread, "epoch": epoch, "id": id, "row": ["index": index, "kind": "user", "items": items, "headed": false, "interactionId": ""]]
    }
    private func step(_ id: String) -> [String: Any] {
        ["id": id, "index": NSNull(), "type": "tool_call", "role": "", "text": "Read \(id)", "complete": true, "createdAt": 0, "agentId": "root", "truncated": false]
    }
    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
}

private final class ThreadActionRecorder: ClientSession, @unchecked Sendable {
    private let lock = NSLock()
    private var actions: [[String: Any]] = []
    var threadActions: [[String: Any]] {
        lock.withLock { actions.compactMap { $0["type"] as? String == "thread" ? $0["action"] as? [String: Any] : nil } }
    }
    func start(itemLimit: Int) {}
    func invoke(_ name: String, json: String) {
        guard let value = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return }
        lock.withLock { actions.append(value) }
    }
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { completion() }
}
