import Foundation
import Testing
@testable import Ace

/// Reopening a thread shown recently, view-only machines on the new request cards and composer
/// controls, and the steps a settled log reads. Native models only; the bridge is recorded.
@Suite @MainActor struct ThreadGapsTests {
    @Test func aThreadLeftAndReopenedShowsItsTranscriptAtOnceAndTakesOnlyItsNewGenerationsChanges() async throws {
        let (model, session) = try await connected()
        model.receive(try frame([
            ["type": "thread.reset", "threadId": "thread", "epoch": 1],
            item("ask", thread: "thread", epoch: 1, index: 0),
            block("turn", thread: "thread", epoch: 1, items: ["ask"], index: 0),
            ["type": "thread.ready", "threadId": "thread", "epoch": 1, "count": 1],
        ]))
        let first = try #require(model.thread)
        model.open("child")
        model.back()
        model.open("thread")
        // The same model comes back, drawn at once, and the bridge is told native kept it.
        #expect(model.thread === first)
        #expect(model.thread?.loaded == true)
        #expect(model.thread?.screen.blockOrder == ["turn"])
        #expect(model.thread?.items["ask"] != nil)
        #expect(session.opens.map { $0["warm"] as? Bool } == [false, false, true])
        // Late patches from the first visit change nothing; the new generation's do.
        model.receive(try frame([block("late", thread: "thread", epoch: 1, items: [], index: 1)]))
        #expect(model.thread?.screen.blocks["late"] == nil)
        let epoch = try #require(model.thread?.epoch)
        model.receive(try frame([block("next", thread: "thread", epoch: epoch, items: [], index: 1)]))
        #expect(model.thread?.screen.blockOrder == ["turn", "next"])
    }
    @Test func aThreadThatNeverFinishedLoadingOrWasPushedOffTheShelfOpensFresh() async throws {
        let (model, session) = try await connected()
        // Left before its first snapshot: nothing worth showing again.
        model.back()
        model.open("thread")
        #expect(model.thread?.loaded == false)
        for index in 0...ThreadShelf.capacity + 1 {
            let id = "other-\(index)"
            model.open(id)
            let epoch = try #require(model.thread?.epoch)
            model.receive(try frame([["type": "thread.ready", "threadId": id, "epoch": epoch, "count": 0]]))
        }
        model.open("other-0")
        #expect(model.thread?.loaded == false)
        model.open("other-\(ThreadShelf.capacity + 1)")
        #expect(model.thread?.loaded == true)
        #expect(session.opens.suffix(2).map { $0["warm"] as? Bool } == [false, true])
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
    @Test func aTurnTheBridgeLetsGoLosesItsRowsWhileOthersKeepTheirs() throws {
        let model = ClientModel(now: { 0 })
        model.open("a")
        model.receive(try frame([
            ["type": "thread.stepsPage", "threadId": "a", "epoch": 1, "ordinal": 2, "page": 0, "rows": [step("s0")]],
            ["type": "thread.steps", "threadId": "a", "epoch": 1, "ordinal": 2, "state": "ready", "pages": 1, "count": 1, "more": false],
            ["type": "thread.stepsPage", "threadId": "a", "epoch": 1, "ordinal": 3, "page": 0, "rows": [step("t0")]],
            ["type": "thread.steps", "threadId": "a", "epoch": 1, "ordinal": 3, "state": "ready", "pages": 1, "count": 1, "more": false],
        ]))
        model.receive(try frame([["type": "thread.stepsReleased", "threadId": "a", "epoch": 1, "ordinal": 2]]))
        #expect(model.thread?.screen.steps[2] == nil)
        #expect(model.thread?.screen.steps[3]?.rows.map(\.id) == ["t0"])
    }

    /// A goal change saved on the phone is still pending: Pause or Clear resolves only on the
    /// daemon's answer, and a refusal comes back to the sheet, not as the screen-wide error.
    @Test func aGoalChangeStaysPendingUntilTheDaemonAnswersAndItsRefusalStaysOnTheSheet() async throws {
        let (model, session) = try await connected()
        let epoch = try #require(model.thread?.epoch)
        var answer: String?? = .none
        let changing = Task { answer = .some(await model.changeGoal("pause", epoch: epoch)) }
        for _ in 0..<50 where session.threadActions.isEmpty { await Task.yield() }
        let id = try #require(session.threadActions.first?["requestId"] as? String)
        model.receive(try frame([["type": "admission", "id": id, "ok": true, "message": ""]]))
        for _ in 0..<50 { await Task.yield() }
        #expect(answer == nil, "saved on the phone is not taken by the daemon")
        model.receive(try frame([["type": "receipt", "id": id, "ok": false, "message": "unsupported_goal"]]))
        await changing.value
        #expect(answer == .some("unsupported_goal"))
        #expect(model.error == nil)
    }
    private func connected() async throws -> (ClientModel, ThreadActionRecorder) {
        let session = ThreadActionRecorder()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { _, _, _, _ in session })
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
    var opens: [[String: Any]] { lock.withLock { actions.filter { $0["type"] as? String == "open" } } }
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
