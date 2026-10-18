import Foundation

/// Thread-screen actions. The bridge builds every payload from the SDK reader (delivery, Stop's
/// fence, answer validation); native code sends the person's intent and waits for admission.
extension ClientModel {
    /// Persist a follow-up: `alternate` asks for the other delivery the composer offered.
    func sendMessage(_ text: String, alternate: Bool) async -> Bool {
        guard canOperate, thread != nil, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) {
            threadAction(["type": "send", "text": text, "opposite": alternate, "requestId": id])
        }
    }
    /// Stop the whole agent tree of the turn on screen.
    func stopTree() {
        guard canOperate, let thread, thread.screen.controls?.canStop == true, !thread.screen.stopping else { return }
        let id = admissions.nextId()
        thread.screen.stopping = true
        Task { [weak self, weak thread] in
            guard let self else { return }
            let saved = await self.admissions.wait(id: id) { self.threadAction(["type": "stop", "requestId": id]) }
            if !saved { thread?.screen.stopping = false }
        }
    }
    /// Answer a question with option ids or, where offered, the person's own words.
    func answer(_ interaction: ApprovalRow, answers: [String: [String]], dismissed: Bool = false) {
        guard canOperate, interaction.kind == "question", interaction.state == "pending", approvalSubmissions[interaction.id] == nil else { return }
        let id = admissions.nextId()
        approvalSubmissions[interaction.id] = ApprovalSubmission(requestId: id, phase: .saving)
        approvalRequests[id] = interaction.id
        let sent = threadAction(["type": "answer", "interactionId": interaction.id, "answers": answers, "dismissed": dismissed, "requestId": id])
        if !sent {
            approvalSubmissions[interaction.id] = nil
            approvalRequests[id] = nil
        }
    }
    /// Send a failed message again: resumed in the daemon's queue when it is still there.
    func retrySend(_ pending: PendingRow) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) { threadAction(["type": "retrySend", "id": pending.id, "requestId": id]) }
    }
    func loadOlder() {
        guard let thread, thread.loaded, thread.screen.hasOlder, !thread.screen.loadingOlder else { return }
        threadAction(["type": "loadOlder"])
    }
    func requestModels() { threadAction(["type": "models"]) }
    func switchModel(_ model: ModelOption) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) { threadAction(["type": "switchModel", "model": model.id, "requestId": id]) }
    }
    /// Change a queued follow-up: `change` is remove, steer (send it now) or new words.
    func editQueued(_ message: QueueRow.Message, change: [String: Any]) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) {
            threadAction(["type": "queue", "messageId": message.id, "change": change, "requestId": id])
        }
    }
    @discardableResult private func threadAction(_ value: [String: Any]) -> Bool {
        let dispatched = action(["type": "thread", "action": value])
        if !dispatched { error = "Could not submit the request. Your draft is still available." }
        return dispatched
    }
}
