import Testing
import Foundation
@testable import Ace

/// Spade's patches as the bridge puts them (`bridge/spade.ts`), received the way frames arrive.
@Suite @MainActor struct SpadeModelTests {
    @Test func aConversationsEntriesDrawInTheBridgesOrderAndAStreamingReplyUpdatesInPlace() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try frame([
            conversation("c1", title: "Weather"),
            ["type": "spade.order", "conversation": "c1", "order": ["u1", "r1"]],
            ["type": "spade.entry", "conversation": "c1", "key": "u1", "row": ["kind": "user", "text": "Will it rain?", "images": NSNull(), "pending": false]],
            reply("c1", "r1", live: "No rain"),
        ]))
        #expect(model.spade.conversation?.title == "Weather")
        #expect(model.spade.order == ["u1", "r1"])
        model.receive(try frame([reply("c1", "r1", live: "No rain today")]))
        #expect(model.spade.entries["r1"] == .reply(parts: [], live: "No rain today", end: nil))
        #expect(model.spade.entries["u1"] == .user(text: "Will it rain?", images: nil, pending: false))
    }

    @Test func anotherConversationsPatchesNeverMixWithTheLastOnesEntries() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try frame([
            conversation("c1", title: "Weather"),
            ["type": "spade.order", "conversation": "c1", "order": ["r1"]],
            reply("c1", "r1", live: "Sunny"),
        ]))
        // The next conversation's entry may arrive before its header: the old entries go either way.
        model.receive(try frame([reply("c2", "r9", live: "Hello")]))
        #expect(model.spade.entries["r1"] == nil)
        #expect(model.spade.conversation == nil)
        model.receive(try frame([conversation("c2", title: "Plans"), ["type": "spade.order", "conversation": "c2", "order": ["r9"]]]))
        #expect(model.spade.order == ["r9"])
        #expect(model.spade.entries["r9"] != nil)
        model.receive(try frame([["type": "spade.conversation.closed"]]))
        #expect(model.spade.conversation == nil)
        #expect(model.spade.entries.isEmpty)
    }

    @Test func theListKeepsItsLastRowsWhileAReadFails() throws {
        let model = ClientModel(now: { 0 })
        let line: [String: Any] = ["sentence": "Spade is running.", "ready": true, "canTurnOn": false]
        model.receive(try frame([["type": "spade.state", "line": line, "enabled": true,
                                  "list": ["rows": [["id": "c1", "title": "Weather", "tone": "idle", "label": "3m"]], "failed": false]]]))
        model.receive(try frame([["type": "spade.state", "line": line, "enabled": true, "list": ["rows": NSNull(), "failed": true]]]))
        #expect(model.spade.rows?.map(\.title) == ["Weather"])
        #expect(model.spade.line?.ready == true)
    }

    @Test func aRefusedMessageComesBackAheadOfWhatWasTypedSince() {
        #expect(SpadeDraft.restoring("Book the train", into: "") == "Book the train")
        #expect(SpadeDraft.restoring("Book the train", into: "And a taxi") == "Book the train\n\nAnd a taxi")
        // Typed again in full while it was out: said once.
        #expect(SpadeDraft.restoring("Book the train", into: "Book the train") == "Book the train")
    }

    @Test func aStartSpadeMayHaveKeepsItsWordsUnderTheNoteForThePersonToDecide() {
        let note = "Couldn't confirm Spade got this. Check Spade's list before sending it again."
        let unknown = SpadeDraft.after(SpadeOutcome(ok: false, unknown: true, note: note), sent: "What's on today?", draft: "")
        #expect(unknown.draft == "What's on today?")
        #expect(unknown.problem == note)
        let refused = SpadeDraft.after(SpadeOutcome(ok: false, title: "Couldn't send to Spade", message: "Today's cap is reached."),
                                       sent: "Hi", draft: "")
        #expect(refused.draft == "Hi")
        #expect(refused.problem == "Couldn't send to Spade. Today's cap is reached.")
        let sent = SpadeDraft.after(SpadeOutcome(ok: true), sent: "Hi", draft: "Next")
        #expect(sent.draft == "Next")
        #expect(sent.problem == nil)
    }

    private func conversation(_ id: String, title: String) -> [String: Any] {
        ["type": "spade.conversation", "id": id, "title": title, "loaded": true, "problem": NSNull(), "busy": false,
         "answering": false, "working": NSNull(), "approval": NSNull()]
    }
    private func reply(_ conversation: String, _ key: String, live: String) -> [String: Any] {
        ["type": "spade.entry", "conversation": conversation, "key": key,
         "row": ["kind": "reply", "parts": [], "live": live, "end": NSNull()]]
    }
    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
}
