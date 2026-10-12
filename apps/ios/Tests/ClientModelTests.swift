import Testing
import Foundation
@testable import Ace

@Suite @MainActor struct ClientModelTests {
    @Test func aDeltaUpdatesOnlyItsVisibleRowAndKeepsHistory() throws {
        let model = ClientModel(now: { 0 })
        model.open("a")
        model.receive(try frame([
            ["type": "thread.reset", "threadId": "a", "epoch": 1],
            item("first", text: "One", index: 0), item("tail", text: "Streaming", index: 1)
        ]))
        let first = model.thread?.items["first"]
        model.receive(try frame([item("tail", text: "Streaming more", index: 1)]))
        #expect(model.thread?.order == ["first", "tail"])
        #expect(model.thread?.items["tail"]?.row.text == "Streaming more")
        #expect(model.thread?.items["first"] === first)
        #expect(first?.row.text == "One")
    }
    @Test func anOldThreadPatchCannotReplaceTheNewConversation() throws {
        let model = ClientModel(now: { 0 })
        model.open("a")
        model.receive(try frame([["type": "thread.reset", "threadId": "a", "epoch": 1], item("one", text: "A", index: 0)]))
        model.open("b")
        model.receive(try frame([["type": "thread.reset", "threadId": "b", "epoch": 2]]))
        model.receive(try frame([item("late", text: "Late A", index: 1)]))
        #expect(model.thread?.id == "b")
        #expect(model.thread?.items.isEmpty == true)
    }
    @Test func corruptUpdatesLeaveTheLastVisibleFactsIntact() throws {
        let model = ClientModel(now: { 0 })
        model.open("a")
        model.receive(try frame([["type": "thread.reset", "threadId": "a", "epoch": 1], item("one", text: "Keep", index: 0)]))
        model.receive(Data("[{\"type\":\"unknown\"}]".utf8))
        #expect(model.thread?.items["one"]?.row.text == "Keep")
        #expect(model.error != nil)
    }
    @Test func reopeningTheSameThreadRejectsUpdatesFromItsPreviousVisit() throws {
        let model = ClientModel(now: { 0 })
        model.open("a")
        model.receive(try frame([["type": "thread.reset", "threadId": "a", "epoch": 1], item("one", text: "Old visit", index: 0)]))
        model.back()
        model.open("a")
        model.receive(try frame([["type": "thread.reset", "threadId": "a", "epoch": 1], item("one", text: "Late old visit", index: 0)]))
        #expect(model.thread?.items.isEmpty == true)
        model.receive(try frame([["type": "thread.reset", "threadId": "a", "epoch": 3]]))
        #expect(model.thread?.items.isEmpty == true)
    }
    private func item(_ id: String, text: String, index: Int) -> [String: Any] {
        ["type": "thread.item", "threadId": "a", "epoch": 1, "id": id,
         "row": ["id": id, "index": index, "type": "message", "role": "assistant", "text": text, "complete": false, "createdAt": 0, "agentId": "root", "truncated": false]]
    }
    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
}
