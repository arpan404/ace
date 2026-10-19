import Foundation
import Testing
@testable import Ace

/// Stop in the Agents sheet through the real ClientModel command path; the VM is a recorder.
@Suite @MainActor struct AgentsSheetTests {
    @Test func stopAllSendsNothingUntilConfirmedThenWaitsForDurableAdmission() async throws {
        let (model, session) = try await connected()
        let stop = StopConfirmation()
        await stop.request(.tree(agents: 3)) { await model.interrupt(agentId: $0.agentId) }
        #expect(stop.asking == .tree(agents: 3))
        #expect(session.commands.isEmpty)
        let confirming = Task { await stop.confirm { await model.interrupt(agentId: $0.agentId) } }
        try await until { session.commands.count == 1 }
        #expect(stop.saving)
        let command = try #require(session.commands.first)
        let payload = try #require(command["payload"] as? [String: Any])
        #expect(payload["type"] as? String == "thread.interrupt")
        #expect(payload["threadId"] as? String == "tree")
        #expect(payload["cascade"] as? Bool == true)
        #expect(payload["agentId"] == nil)
        // Admission is the SDK's persistence boundary; the agents' own status reports the stop.
        model.receive(try patch(["type": "admission", "id": try #require(command["requestId"] as? String), "ok": true, "message": ""]))
        await confirming.value
        #expect(stop.phase == .admitted(.tree(agents: 3)))
    }
    @Test func cancellingStopAllSendsNothing() async throws {
        let (model, session) = try await connected()
        let stop = StopConfirmation()
        await stop.request(.tree(agents: 2)) { await model.interrupt(agentId: $0.agentId) }
        stop.cancel()
        await stop.confirm { await model.interrupt(agentId: $0.agentId) }
        #expect(stop.phase == .idle)
        #expect(session.commands.isEmpty)
    }
    @Test func aLeafAgentStopsAtOnceAndARefusedAdmissionIsReported() async throws {
        let (model, session) = try await connected()
        let stop = StopConfirmation()
        let target = StopConfirmation.Target.agent(id: "reviewer", name: "Reviewer", descendants: 0)
        let stopping = Task { await stop.request(target) { await model.interrupt(agentId: $0.agentId) } }
        try await until { session.commands.count == 1 }
        let command = try #require(session.commands.first)
        #expect((command["payload"] as? [String: Any])?["agentId"] as? String == "reviewer")
        model.receive(try patch(["type": "admission", "id": try #require(command["requestId"] as? String), "ok": false, "message": "Could not save"]))
        await stopping.value
        #expect(stop.phase == .failed(target))
    }
    @Test func anAgentWithSubagentsAsksBeforeStoppingThemToo() async throws {
        let (model, session) = try await connected()
        let stop = StopConfirmation()
        await stop.request(.agent(id: "lead", name: "Lead", descendants: 2)) { await model.interrupt(agentId: $0.agentId) }
        #expect(stop.asking?.title == "Stop Lead and 2 subagents?")
        #expect(session.commands.isEmpty)
    }
    @Test func aViewOnlyPhoneCannotStopAnything() async throws {
        let (model, session) = try await connected()
        model.canOperate = false
        #expect(await model.interrupt(agentId: nil) == false)
        #expect(await model.stopTask("task-1") == false)
        #expect(model.gitStep(["kind": "push"]) == nil)
        #expect(session.commands.isEmpty)
        #expect(session.sheetActions.isEmpty)
    }
    @Test func anAgentsPatchForAnEarlierVisitIsIgnored() async throws {
        let (model, _) = try await connected()
        let sheet: [String: Any] = [
            "rows": [], "hidden": ["agents": 0, "running": 0], "tasks": [], "hiddenTasks": 0,
            "totals": ["agents": 1, "running": 1, "needsYou": 0], "treeRunning": true,
        ]
        model.receive(try patch(["type": "agents.sheet", "threadId": "tree", "epoch": 0, "sheet": sheet]))
        #expect(model.sheets.agents == nil)
        model.receive(try patch(["type": "agents.sheet", "threadId": "tree", "epoch": model.thread?.epoch ?? -1, "sheet": sheet]))
        #expect(model.sheets.agents?.treeRunning == true)
    }

    private func connected() async throws -> (ClientModel, RecordingSession) {
        let session = RecordingSession()
        let model = ClientModel(now: { 0 }, makeRuntime: { _, _, _, _ in session })
        let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:1")), hostId: "host", deviceId: "device", pin: nil,
                                      credential: { "{}" })
        await model.connect(target: target, directory: FileManager.default.temporaryDirectory)
        model.open("tree")
        return (model, session)
    }
    private func patch(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: [value]) }
    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<500 where !condition() { await Task.yield() }
        #expect(condition())
    }
}

private final class RecordingSession: ClientSession, @unchecked Sendable {
    private let lock = NSLock()
    private var actions: [[String: Any]] = []
    var commands: [[String: Any]] { lock.withLock { actions.filter { $0["type"] as? String == "command" } } }
    var sheetActions: [[String: Any]] { lock.withLock { actions.filter { $0["type"] as? String == "sheet" } } }
    func start(itemLimit: Int) {}
    func invoke(_ name: String, json: String) {
        guard let value = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return }
        lock.withLock { actions.append(value) }
    }
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { completion() }
}
