import Foundation
import Testing
@testable import Ace

/// Streaming text arrives as edits of the row on screen (`bridge/text-edit.ts`); a frame whose edit
/// was made against other text is turned down whole, so the bridge sends the row again.
@Suite @MainActor struct StreamingTextTests {
    private func row(_ text: String) -> [String: Any] {
        ["id": "a", "index": 0, "type": "message", "role": "assistant", "text": text, "complete": false,
         "createdAt": 0, "agentId": "", "truncated": false, "detail": "", "quiet": false]
    }
    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
    private func edit(_ epoch: Int, base: Int, cut: Int, append: String) -> [String: Any] {
        ["type": "thread.item.text", "threadId": "thread", "epoch": epoch, "id": "a", "row": row(""),
         "base": base, "cut": cut, "append": append]
    }

    @Test func editsDuringAReplacementApplyToIncomingTextWhileTheOldAnswerStaysVisible() throws {
        let model = ClientModel(now: { 0 })
        model.open("thread")
        let reset: [String: Any] = ["type": "thread.reset", "threadId": "thread", "epoch": 1]
        let ready: [String: Any] = ["type": "thread.ready", "threadId": "thread", "epoch": 1, "count": 1]
        let original: [String: Any] = ["type": "thread.item", "threadId": "thread", "epoch": 1, "id": "a", "row": row("Old answer")]
        #expect(model.receive(try frame([reset, original, ready])))
        let replacement: [String: Any] = ["type": "thread.item", "threadId": "thread", "epoch": 1, "id": "a", "row": row("New")]
        #expect(model.receive(try frame([reset, replacement])))
        #expect(model.thread?.items["a"]?.row.text == "Old answer")
        #expect(model.receive(try frame([edit(1, base: 3, cut: 0, append: " answer")])))
        #expect(model.thread?.items["a"]?.row.text == "Old answer")
        #expect(model.receive(try frame([ready])))
        #expect(model.thread?.items["a"]?.row.text == "New answer")
    }

    @Test func anEditExtendsOrSlidesTheRowShown() throws {
        let model = ClientModel(now: { 0 })
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        #expect(model.receive(try frame([["type": "thread.item", "threadId": "thread", "epoch": epoch, "id": "a", "row": row("Hello 😀")]])))
        #expect(model.receive(try frame([edit(epoch, base: 10, cut: 0, append: " world")])))
        #expect(model.thread?.items["a"]?.row.text == "Hello 😀 world")
        // A sliding window drops whole characters from the front, counted in UTF-8 bytes.
        #expect(model.receive(try frame([edit(epoch, base: 16, cut: 6, append: "!")])))
        #expect(model.thread?.items["a"]?.row.text == "😀 world!")
    }

    @Test func anEditAgainstOtherTextTurnsTheWholeFrameDownAndChangesNothing() throws {
        let model = ClientModel(now: { 0 })
        model.open("thread")
        let epoch = try #require(model.thread?.epoch)
        model.receive(try frame([["type": "thread.item", "threadId": "thread", "epoch": epoch, "id": "a", "row": row("Hello")]]))
        let other: [String: Any] = ["type": "thread.cursor", "threadId": "thread", "epoch": epoch, "cursor": 7]
        #expect(!model.receive(try frame([other, edit(epoch, base: 9, cut: 0, append: " there")])))
        #expect(model.thread?.items["a"]?.row.text == "Hello")
        #expect(model.thread?.cursor != 7)
        #expect(model.error == nil)
        // A cut inside a character is refused the same way.
        #expect(model.receive(try frame([edit(epoch, base: 5, cut: 0, append: " 😀")])))
        #expect(!model.receive(try frame([edit(epoch, base: 10, cut: 7, append: "!")])))
        #expect(model.thread?.items["a"]?.row.text == "Hello 😀")
    }
}
