import Testing
import Foundation
@testable import Ace

@Suite @MainActor struct ThreadScreenTests {
    @Test func blocksKeepTheirOrderAndIdentityWhileTheirItemsStream() throws {
        let model = ClientModel(now: { 0 })
        model.open("a")
        model.receive(try frame([
            ["type": "thread.reset", "threadId": "a", "epoch": 1],
            item("ask", role: "user", text: "Go", index: 0), item("answer", text: "Work", index: 1),
            block("turn-ask", kind: "user", items: ["ask"], index: 0),
            block("turn-answer", kind: "message", items: ["answer"], index: 1),
        ]))
        let answer = try #require(model.thread?.screen.blocks["turn-answer"])
        model.receive(try frame([item("answer", text: "Working on it", index: 1)]))
        #expect(model.thread?.screen.blockOrder == ["turn-ask", "turn-answer"])
        #expect(model.thread?.screen.blocks["turn-answer"] === answer)
        #expect(model.thread?.items["answer"]?.row.text == "Working on it")
        model.receive(try frame([
            ["type": "thread.blockPosition", "threadId": "a", "epoch": 1, "id": "turn-answer", "index": 2],
            block("older", kind: "message", items: [], index: 0),
            ["type": "thread.blockPosition", "threadId": "a", "epoch": 1, "id": "turn-ask", "index": 1],
        ]))
        #expect(model.thread?.screen.blockOrder == ["older", "turn-ask", "turn-answer"])
        model.receive(try frame([["type": "thread.block", "threadId": "a", "epoch": 1, "id": "older"]]))
        #expect(model.thread?.screen.blockOrder == ["turn-ask", "turn-answer"])
    }
    @Test func aChildThreadOpenedFromASubagentRejectsItsParentsLateBlocks() throws {
        let model = ClientModel(now: { 0 })
        model.open("a")
        model.receive(try frame([["type": "thread.reset", "threadId": "a", "epoch": 1], block("parent", kind: "subagents", items: [], index: 0)]))
        model.open("child")
        model.receive(try frame([
            block("late-parent", kind: "message", items: [], index: 1),
            ["type": "thread.controls", "threadId": "a", "epoch": 1, "row": controls(busy: true)],
            ["type": "thread.reset", "threadId": "child", "epoch": 2],
            ["type": "thread.block", "threadId": "child", "epoch": 2, "id": "child-turn", "row": blockRow(kind: "message", items: [], index: 0)],
        ]))
        #expect(model.thread?.id == "child")
        #expect(model.thread?.screen.blockOrder == ["child-turn"])
        #expect(model.thread?.screen.controls == nil)
        model.open("a")
        model.receive(try frame([block("late-parent", kind: "message", items: [], index: 1)]))
        #expect(model.thread?.screen.blocks.isEmpty == true)
    }
    @Test func stoppingClearsOnceTheTreeIsNoLongerBusy() throws {
        let model = ClientModel(now: { 0 })
        model.open("a")
        model.receive(try frame([["type": "thread.controls", "threadId": "a", "epoch": 1, "row": controls(busy: true)]]))
        model.thread?.screen.stopping = true
        model.receive(try frame([["type": "thread.controls", "threadId": "a", "epoch": 1, "row": controls(busy: true)]]))
        #expect(model.thread?.screen.stopping == true)
        model.receive(try frame([["type": "thread.controls", "threadId": "a", "epoch": 1, "row": controls(busy: false)]]))
        #expect(model.thread?.screen.stopping == false)
    }
    @Test func approvalVerbsNameTheExactOfferedOptionsAndLeaveTheRestUnderMore() throws {
        let options = (0..<4).map { ApprovalRow.Option(id: "option-\($0)", label: "Choice \($0)", kind: $0 == 0 ? "deny" : $0 == 1 ? "allow_session" : $0 == 2 ? "allow_once" : "cancel") }
        var row = ApprovalRow(id: "approval", kind: "approval", state: "pending", title: "Run", description: "", command: "", options: options, truncated: false)
        row.decisions = [
            .init(verb: "allow_once", option: 2, label: "Allow once", scope: "", emphasis: "primary"),
            .init(verb: "always_allow", option: 1, label: "Always allow", scope: "Always here", emphasis: "quiet"),
            .init(verb: "deny", option: 0, label: "Deny", scope: "", emphasis: "quiet"),
            .init(verb: "deny", option: 9, label: "Deny", scope: "", emphasis: "quiet"),
        ]
        row.others = [.init(option: 3, label: "Cancel the turn")]
        #expect(row.verbs.map(\.option.id) == ["option-0", "option-1", "option-2"])
        #expect(row.remaining.map(\.option.id) == ["option-3"])
        #expect(row.remaining.map(\.label) == ["Cancel the turn"])
    }
    @Test func aQuestionAnswerNeedsEveryQuestionAndKeepsOwnWordsOnlyWhereAllowed() {
        let scope = ApprovalRow.Question(id: "scope", header: "", text: "Which?", multiSelect: false, allowOther: true,
                                         options: [.init(id: "a", label: "A", detail: "", recommended: false), .init(id: "b", label: "B", detail: "", recommended: false)])
        let checks = ApprovalRow.Question(id: "checks", header: "", text: "Run?", multiSelect: true, allowOther: false,
                                          options: [.init(id: "lint", label: "Lint", detail: "", recommended: false), .init(id: "test", label: "Test", detail: "", recommended: false)])
        var answers = QuestionAnswers()
        answers.pick("a", in: scope)
        #expect(answers.resolution(for: [scope, checks]) == nil)
        answers.pick("lint", in: checks)
        answers.pick("test", in: checks)
        answers.pick("lint", in: checks)
        answers.write("words for checks", in: checks)
        #expect(answers.resolution(for: [scope, checks]) == ["scope": ["a"], "checks": ["test"]])
        answers.write("  Only 2024  ", in: scope)
        #expect(answers.resolution(for: [scope, checks]) == ["scope": ["Only 2024"], "checks": ["test"]])
        answers.pick("b", in: scope)
        #expect(answers.resolution(for: [scope, checks]) == ["scope": ["b"], "checks": ["test"]])
    }
    private func item(_ id: String, role: String = "assistant", text: String, index: Int) -> [String: Any] {
        ["type": "thread.item", "threadId": "a", "epoch": 1, "id": id,
         "row": ["id": id, "index": index, "type": "message", "role": role, "text": text, "complete": false, "createdAt": 0, "agentId": "root", "truncated": false]]
    }
    private func block(_ id: String, kind: String, items: [String], index: Int) -> [String: Any] {
        ["type": "thread.block", "threadId": "a", "epoch": 1, "id": id, "row": blockRow(kind: kind, items: items, index: index)]
    }
    private func blockRow(kind: String, items: [String], index: Int) -> [String: Any] {
        ["index": index, "kind": kind, "items": items, "headed": false, "interactionId": ""]
    }
    private func controls(busy: Bool) -> [String: Any] {
        ["busy": busy, "delivery": busy ? "queue" : NSNull(), "alternate": busy ? "steer" : NSNull(), "canStop": busy, "provider": "codex", "model": "GPT", "switching": ""]
    }
    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
}
