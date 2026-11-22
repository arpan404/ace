import Foundation

/// A conversation with a bot: send, stop, answer an approval or a card of questions, turn Spade
/// on, and pin the bot (`bridge/spade-requests-conversation.ts`).
extension ClientModel {
    /// A message: its words, the files staged for it (`AttachmentStaging`) and a recording. Words
    /// may be empty when it carries something; the bridge checks Spade's limits before any of it
    /// goes, and a message with files has as long as a large upload needs.
    func spadeSend(_ conversation: String, text: String, files: [StagedAttachment] = [], voice: StagedAttachment? = nil) async -> SpadeOutcome {
        var payload: [String: Any] = ["type": "spade.send", "conversationId": conversation, "text": text]
        if !files.isEmpty { payload["files"] = files.map(\.json) }
        if let voice { payload["voice"] = voice.json }
        let carries = !files.isEmpty || voice != nil
        return await spadeRequest(payload, failing: "Couldn't send", timeout: carries ? .seconds(15 * 60) : .seconds(70))
    }
    func spadeStop(_ conversation: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.stop", "conversationId": conversation], failing: "Couldn't stop")
    }
    func spadeAnswer(_ conversation: String, callId: String, allowed: Bool, always: Bool) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.answer", "conversationId": conversation, "callId": callId,
                            "allowed": allowed, "always": always], failing: "Couldn't answer")
    }
    /// A card of questions: `reply` is its drafts (`["drafts": [...]]`), `["defer": true]` or
    /// `["dismiss": true]`.
    func spadeQuestion(_ conversation: String, callId: String, reply: [String: Any]) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.question", "conversationId": conversation, "callId": callId, "reply": reply],
                           failing: "Couldn't answer")
    }
    /// A sent card not yet settled: the conversation's events since the last one shown, read again.
    func spadeQuestionRead(_ conversation: String, callId: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.question.read", "conversationId": conversation, "callId": callId],
                           failing: "Couldn't read the conversation")
    }
    func spadeTurnOn() async -> SpadeOutcome {
        await spadeRequest(["type": "spade.enable"], failing: "Couldn't turn on Spade")
    }
    /// Pins the bot to the strip above the list, or unpins it, on every device.
    func spadePin(_ agent: String, pinned: Bool) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.pin", "agentId": agent, "pinned": pinned],
                           failing: pinned ? "Couldn't pin" : "Couldn't unpin")
    }
}
