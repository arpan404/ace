import Foundation

extension ClientModel {
    /// The Spade tab shows this machine's bots, or no longer does.
    func spadeWatch(_ on: Bool) {
        guard spade.watching != on else { return }
        spade.watching = on
        action(["type": "spade.watch", "on": on])
    }
    /// Follow `id` live, or no conversation.
    func spadeOpen(_ id: String?) {
        guard spade.opened != id else { return }
        spade.opened = id
        action(["type": "spade.open", "conversationId": id.map { $0 as Any } ?? NSNull()])
    }
    func spadeRetry() { action(["type": "spade.retry"]) }
    /// Read Spade's state and the bots again now.
    func spadeRefresh() { action(["type": "spade.refresh"]) }
    /// A new runtime knows nothing of what shows: tell it again.
    func spadeResume() {
        if spade.watching { action(["type": "spade.watch", "on": true]) }
        if let id = spade.opened { action(["type": "spade.open", "conversationId": id]) }
    }
    /// A Spade request; a transport failure reads as a refusal with its words.
    func spadeRequest(_ payload: [String: Any], failing title: String) async -> SpadeOutcome {
        do { return try await service(payload, as: SpadeOutcome.self, timeout: .seconds(70)) }
        catch is CancellationError { return SpadeOutcome(ok: false) }
        catch { return SpadeOutcome(ok: false, title: title, message: error.localizedDescription) }
    }
    func spadeSend(_ conversation: String, text: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.send", "conversationId": conversation, "text": text], failing: "Couldn't send")
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
}

extension MachineInbox {
    /// The machines that show Spade (Settings › Beta), in the inbox's order: the Spade tab is
    /// there while any does.
    var spadeSessions: [MachineSession] { sessions.filter { $0.client.spade.shown == true } }
    /// A Spade bot works on a machine that shows Spade: the tab's face moves its eyes.
    var spadeWorking: Bool {
        spadeSessions.contains { $0.client.spade.bots?.contains { $0.state == "working" } == true }
    }
}
