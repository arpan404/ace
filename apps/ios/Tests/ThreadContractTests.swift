import Foundation
import Testing
@testable import Ace

/// The thread screen over the real JavaScriptCore bridge and the local spike fixture's thread
/// scenarios (`scripts/thread-scenarios.ts`). No provider CLI is invoked.
@Suite(.serialized) @MainActor struct ThreadContractTests {
    @Test func aFinishedTurnFoldsBehindWorkedForAndTheSubagentGroupOpensTheDelegatedChild() async throws {
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        model.open("ios-agents")
        let work = try await until("a folded work head") {
            model.thread?.screen.blocks.values.first { $0.row.kind == "work" && $0.row.work?.ongoing == false }?.row
        }
        #expect(work.work?.label.hasPrefix("Worked for") == true)
        #expect(work.work?.counts.contains("Explored 2 files") == true)
        #expect(work.work?.counts.contains("Ran 1 command") == true)
        let steps = work.items.compactMap { model.thread?.items[$0]?.row.step?.verb }
        #expect(steps.contains("Read"))
        let group = try await until("the subagent group") {
            model.thread?.screen.blocks.values.first { $0.row.kind == "subagents" }?.row.agents
        }
        let states = Dictionary(uniqueKeysWithValues: group.entries.map { ($0.title, $0.state) })
        #expect(states["Explore process groups"] == "done")
        #expect(states["Write orphan-cleanup tests"] == "working")
        let review = try #require(group.entries.first { $0.title == "Review PID-reuse safety" })
        #expect(review.threadId == "ios-agents-review")
        #expect(model.inbox["ios-agents"]?.state == "working")
        model.open(review.threadId)
        _ = try await until("the child thread") { model.thread?.metadata?.title == "Review PID-reuse safety" ? true : nil }
        _ = try await until("the child's own blocks") { model.thread?.screen.blockOrder.isEmpty == false ? true : nil }
        #expect(model.thread?.screen.blocks.values.contains { $0.row.kind == "subagents" } == false)
        model.open("ios-agents")
        _ = try await until("the parent again") { model.thread?.screen.blocks.values.contains { $0.row.kind == "subagents" } == true ? true : nil }
        #expect(model.error == nil)
    }
    @Test func whileTheAgentWorksTheComposerOffersQueueAndSteerAndBothAreAdmitted() async throws {
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        model.open("ios-agents")
        let controls = try await until("composer controls") { model.thread?.screen.controls }
        #expect(controls.busy)
        #expect(controls.delivery == "queue")
        #expect(controls.alternate == "steer")
        #expect(await model.sendMessage("Queue: also run lint \(UUID().uuidString)", alternate: false))
        #expect(await model.sendMessage("Steer: skip the docs \(UUID().uuidString)", alternate: true))
        #expect(model.error == nil)
    }
    @Test func answeringAQuestionIsAdmittedThenClosedOnlyByTheDaemon() async throws {
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        model.open("ios-question")
        let question = try await until("the question card") { model.thread?.approvals.first { $0.kind == "question" } }
        let options = question.questions?.first?.options ?? []
        #expect(options.map(\.label) == ["Skip the archive", "Keep everything"])
        #expect(options.first?.recommended == true)
        model.answer(question, answers: ["archive": ["skip"]])
        #expect(model.approvalSubmissions[question.id] != nil)
        _ = try await until("the canonical resolution") { model.thread?.interactions[question.id]?.state == "resolved" ? true : nil }
        #expect(model.thread?.approvals.isEmpty == true)
        #expect(model.approvalSubmissions[question.id] == nil)
    }
    @Test func alwaysAllowResolvesWithTheRequestsOwnStandingGrant() async throws {
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        model.open("ios-approval")
        let approval = try await until("the approval card") { model.thread?.approvals.first { $0.kind == "approval" } }
        let always = try #require(approval.verbs.first { $0.decision.verb == "always_allow" })
        #expect(always.option.id == "always")
        #expect(always.decision.scope == "Always here")
        model.approve(approval, option: always.option)
        _ = try await until("the canonical resolution") { model.thread?.interactions[approval.id]?.state == "resolved" ? true : nil }
        let (data, _) = try await URLSession.shared.data(from: #require(URL(string: "http://127.0.0.1:\(SpikeFixture.port)/state?thread=ios-approval")))
        #expect(String(decoding: data, as: UTF8.self).contains("\"optionId\":\"always\""))
    }
    @Test func stopInterruptsTheWholeTreeAndClearsOnceItSettles() async throws {
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        model.open("ios-stop")
        _ = try await until("Stop offered") { model.thread?.screen.controls?.canStop == true ? true : nil }
        model.stopTree()
        #expect(model.thread?.screen.stopping == true)
        _ = try await until("the tree stops") { model.thread?.screen.controls?.busy == false ? true : nil }
        #expect(model.thread?.screen.stopping == false)
        #expect(model.inbox["ios-stop"]?.state != "working")
    }
    private func connected() async throws -> (ClientModel, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = ClientModel(now: { 0 })
        await model.connect(target: ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:\(SpikeFixture.port)")), hostId: "ios-spike-host",
                                                     deviceId: "ios-thread-contract", pin: nil, credential: { "{\"token\":\"ios-spike-token\"}" }),
                            directory: root)
        _ = try await until("ready") { model.connection == "ready" ? true : nil }
        return (model, root)
    }
    private func until<T>(_ label: String, _ read: () -> T?) async throws -> T {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(25))
        while true {
            if let value = read() { return value }
            if clock.now >= deadline { throw ThreadContractError.timeout(label) }
            try await Task.sleep(for: .milliseconds(25))
        }
    }
}
private enum ThreadContractError: Error { case timeout(String) }
