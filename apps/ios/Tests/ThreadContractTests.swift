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
    /// The main agent only waits on its subagents: a message goes straight in, and the modified
    /// send queues it (`@ace/ui-core` waitingDelivery), from the first controls the phone shows.
    @Test func whileTheMainAgentOnlyWaitsOnSubagentsAMessageGoesInNowOrQueuesAndBothAreAdmitted() async throws {
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        model.open("ios-agents")
        let controls = try await until("composer controls") { model.thread?.screen.controls }
        #expect(controls.busy)
        #expect(controls.delivery == "steer")
        #expect(controls.alternate == "queue")
        #expect(await model.sendMessage("Queue: also run lint \(UUID().uuidString)", alternate: false))
        #expect(await model.sendMessage("Steer: skip the docs \(UUID().uuidString)", alternate: true))
        #expect(model.error == nil)
    }
    @Test func aQueuedFollowUpShowsAboveTheComposerUntilItIsRemoved() async throws {
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        model.open(try await SpikeFixture.fresh("stop"))
        _ = try await until("a working thread") { model.thread?.screen.controls?.busy == true ? true : nil }
        let text = "Queued for later \(UUID().uuidString)"
        #expect(await model.sendMessage(text, alternate: false))
        let queued = try await until("the queued message") { model.thread?.screen.queue?.messages.first { $0.text == text } }
        #expect(model.thread?.items.values.contains { $0.row.text == text } == false)
        #expect(await model.editQueued(queued, change: ["kind": "remove"]))
        _ = try await until("the removal") { model.thread?.screen.queue?.messages.contains { $0.text == text } == false ? true : nil }
    }
    @Test func answeringAQuestionIsAdmittedThenClosedOnlyByTheDaemon() async throws {
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        model.open(try await SpikeFixture.fresh("question"))
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
        let threadId = try await SpikeFixture.fresh("approval")
        model.open(threadId)
        let approval = try await until("the approval card") { model.thread?.approvals.first { $0.kind == "approval" } }
        let always = try #require(approval.verbs.first { $0.decision.verb == "always_allow" })
        #expect(always.option.id == "always")
        #expect(always.decision.scope == "Always here")
        model.approve(approval, option: always.option)
        _ = try await until("the canonical resolution") { model.thread?.interactions[approval.id]?.state == "resolved" ? true : nil }
        let (data, _) = try await URLSession.shared.data(from: #require(URL(string: "http://127.0.0.1:\(SpikeFixture.port)/state?thread=\(threadId)")))
        #expect(String(decoding: data, as: UTF8.self).contains("\"optionId\":\"always\""))
    }
    @Test func stopInterruptsTheWholeTreeAndClearsOnceItSettles() async throws {
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        let threadId = try await SpikeFixture.fresh("stop")
        model.open(threadId)
        _ = try await until("Stop offered") { model.thread?.screen.controls?.canStop == true ? true : nil }
        model.stopTree()
        #expect(model.thread?.screen.stopping == true)
        _ = try await until("the tree stops") { model.thread?.screen.controls?.busy == false ? true : nil }
        #expect(model.thread?.screen.stopping == false)
        #expect(model.inbox[threadId]?.state != "working")
    }
    @Test func aPlanSentBackCarriesTheFeedbackAndClosesOnlyByTheDaemon() async throws {
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        let threadId = try await SpikeFixture.fresh("plan")
        model.open(threadId)
        let plan = try await until("the plan card") { model.thread?.approvals.first { $0.kind == "plan_review" } }
        #expect(plan.plan?.title == "Kill-all filters")
        #expect(plan.plan?.todos.count == 3)
        model.resolve(plan, answer: ["kind": "plan", "decision": "reject", "feedback": "Also cover zombie processes"])
        #expect(model.approvalSubmissions[plan.id] != nil)
        _ = try await until("the canonical resolution") { model.thread?.interactions[plan.id]?.state == "resolved" ? true : nil }
        #expect(model.approvalSubmissions[plan.id] == nil)
        let (data, _) = try await URLSession.shared.data(from: #require(URL(string: "http://127.0.0.1:\(SpikeFixture.port)/state?thread=\(threadId)")))
        #expect(String(decoding: data, as: UTF8.self).contains("Also cover zombie processes"))
    }
    @Test func aFormIsSubmittedWithTypedValuesAndARefusedOneGivesTheControlsBack() async throws {
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        let threadId = try await SpikeFixture.fresh("form")
        model.open(threadId)
        let form = try await until("the form card") { model.thread?.approvals.first { $0.kind == "elicitation" } }
        #expect(form.form?.fields.map(\.key) == ["region", "replicas", "note"])
        model.resolve(form, answer: ["kind": "form", "action": "accept", "values": ["region": "eu-west", "replicas": "9"]])
        _ = try await until("the refusal") { model.approvalSubmissions[form.id] == nil && model.error != nil ? true : nil }
        model.error = nil
        model.resolve(form, answer: ["kind": "form", "action": "accept", "values": ["region": "eu-west", "replicas": "2"]])
        _ = try await until("the canonical resolution") { model.thread?.interactions[form.id]?.state == "resolved" ? true : nil }
        let (data, _) = try await URLSession.shared.data(from: #require(URL(string: "http://127.0.0.1:\(SpikeFixture.port)/state?thread=\(threadId)")))
        #expect(String(decoding: data, as: UTF8.self).contains("\"replicas\":2"))
    }
    @Test func aFinishedTurnOpensItsFullStepsFromTheDaemon() async throws {
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        model.open("ios-agents")
        let head = try await until("a settled head with its turn") {
            model.thread?.screen.blocks.values.first { $0.row.kind == "work" && $0.row.ordinal != nil }
        }
        let ordinal = try #require(head.row.ordinal)
        model.openSteps(ordinal: ordinal, block: head.id)
        let steps = try await until("the steps") { model.thread?.screen.steps[ordinal]?.header?.state == "ready" ? model.thread?.screen.steps[ordinal]?.rows : nil }
        #expect(steps.contains { $0.step?.verb == "Read" })
        #expect(steps.contains { $0.step?.verb == "Ran" })
        model.closeSteps(ordinal: ordinal)
    }
    /// SwiftUI closes an open log on disappear, after Back already ended the thread's session.
    @Test func anOpenLogClosingAfterGoingBackRaisesNoRequestError() async throws {
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        model.open("ios-agents")
        let head = try await until("a settled head with its turn") {
            model.thread?.screen.blocks.values.first { $0.row.kind == "work" && $0.row.ordinal != nil }
        }
        let ordinal = try #require(head.row.ordinal)
        let epoch = try #require(model.thread?.epoch)
        model.openSteps(ordinal: ordinal, block: head.id)
        _ = try await until("the steps") { model.thread?.screen.steps[ordinal]?.header?.state == "ready" ? true : nil }
        model.back()
        model.closeSteps(ordinal: ordinal, epoch: epoch)
        model.closeLane(epoch: epoch)
        // A later thread's first blocks arrive after anything the releases could have raised.
        model.open("ios-agents-review")
        _ = try await until("the next thread") { model.thread?.screen.blockOrder.isEmpty == false ? true : nil }
        #expect(model.error == nil)
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
