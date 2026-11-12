import Testing
import Foundation
@testable import Ace

/// Spade's patches as the bridge puts them (`bridge/spade.ts`), received the way frames arrive.
@Suite @MainActor struct SpadeModelTests {
    @Test func aBotsBubblesDrawInTheBridgesOrderAndAStreamingReplyUpdatesInPlace() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try frame([
            conversation("a1"),
            ["type": "spade.order", "agentId": "a1", "order": ["u1", "r1"]],
            ["type": "spade.bubble", "agentId": "a1", "key": "u1",
             "row": ["kind": "person", "text": "Will it rain?", "attachments": NSNull(), "sending": false]],
            reply("a1", "r1", text: "No rain"),
        ]))
        #expect(model.spade.conversation?.agentId == "a1")
        #expect(model.spade.order == ["u1", "r1"])
        model.receive(try frame([reply("a1", "r1", text: "No rain today")]))
        #expect(model.spade.bubbles["r1"] == .bot(text: "No rain today", live: true, end: nil, failure: nil, attachments: nil))
        #expect(model.spade.bubbles["u1"] == .person(text: "Will it rain?", attachments: nil, sending: false))
    }

    @Test func anotherBotsPatchesNeverMixWithTheLastOnesBubbles() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try frame([
            conversation("a1"),
            ["type": "spade.order", "agentId": "a1", "order": ["r1"]],
            reply("a1", "r1", text: "Sunny"),
        ]))
        // The next bot's bubble may arrive before its header: the old bubbles go either way.
        model.receive(try frame([reply("a2", "r9", text: "Hello")]))
        #expect(model.spade.bubbles["r1"] == nil)
        #expect(model.spade.conversation == nil)
        model.receive(try frame([conversation("a2"), ["type": "spade.order", "agentId": "a2", "order": ["r9"]]]))
        #expect(model.spade.order == ["r9"])
        #expect(model.spade.bubbles["r9"] != nil)
        model.receive(try frame([["type": "spade.conversation.closed"]]))
        #expect(model.spade.conversation == nil)
        #expect(model.spade.bubbles.isEmpty)
    }

    @Test func anApprovalBubbleCarriesWhatItsButtonsAnswer() throws {
        let model = ClientModel(now: { 0 })
        model.receive(try frame([
            conversation("a1"),
            ["type": "spade.bubble", "agentId": "a1", "key": "k1",
             "row": ["kind": "ask", "callId": "k1", "sentence": "Mailer wants to send an email.", "reason": NSNull(),
                     "command": "ls -la", "details": NSNull()]],
        ]))
        #expect(model.spade.bubbles["k1"] == .ask(callId: "k1", sentence: "Mailer wants to send an email.", reason: nil,
                                                  command: "ls -la", details: nil))
    }

    @Test func theRosterKeepsItsLastBotsWhileAReadFails() throws {
        let model = ClientModel(now: { 0 })
        let line: [String: Any] = ["sentence": "Spade is running.", "ready": true, "canTurnOn": false]
        let bot: [String: Any] = ["id": "spade", "conversation": "c-spade", "main": true, "name": "Spade",
                                  "face": ["kind": "spade"], "age": "3m", "line": "No messages yet", "tone": NSNull(), "working": false]
        model.receive(try frame([["type": "spade.state", "line": line, "setup": NSNull(), "enabled": true,
                                  "roster": ["rows": [bot], "failed": false]]]))
        model.receive(try frame([["type": "spade.state", "line": line, "setup": NSNull(), "enabled": true,
                                  "roster": ["rows": NSNull(), "failed": true]]]))
        #expect(model.spade.bots?.map(\.name) == ["Spade"])
        #expect(model.spade.bot("spade")?.main == true)
        #expect(model.spade.line?.ready == true)
    }

    @Test func aRefusedMessageComesBackAheadOfWhatWasTypedSince() {
        #expect(SpadeDraft.restoring("Book the train", into: "") == "Book the train")
        #expect(SpadeDraft.restoring("Book the train", into: "And a taxi") == "Book the train\n\nAnd a taxi")
        // Typed again in full while it was out: said once.
        #expect(SpadeDraft.restoring("Book the train", into: "Book the train") == "Book the train")
        let refused = SpadeDraft.after(SpadeOutcome(ok: false, title: "Couldn't send it", message: "Scout is at its daily cap."),
                                       sent: "Hi", draft: "")
        #expect(refused.draft == "Hi")
        #expect(refused.problem == "Couldn't send it. Scout is at its daily cap.")
        let sent = SpadeDraft.after(SpadeOutcome(ok: true), sent: "Hi", draft: "Next")
        #expect(sent.draft == "Next")
        #expect(sent.problem == nil)
    }

    @Test func aBotSpadeMayHaveMadeSaysTheNoteNotARefusal() {
        let note = "Couldn't confirm Spade made this bot. Check the list before making it again."
        #expect(SpadeOutcome(ok: false, unknown: true, note: note).words == note)
        #expect(SpadeOutcome(ok: true).words == nil)
    }

    private func conversation(_ agentId: String) -> [String: Any] {
        ["type": "spade.conversation", "agentId": agentId, "loaded": true, "problem": NSNull(), "busy": false, "status": NSNull()]
    }
    private func reply(_ agentId: String, _ key: String, text: String) -> [String: Any] {
        ["type": "spade.bubble", "agentId": agentId, "key": key,
         "row": ["kind": "bot", "text": text, "live": true, "end": NSNull(), "failure": NSNull(), "attachments": NSNull()]]
    }
    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
}
