import Foundation

/// Thread-screen actions. The bridge builds every payload from the SDK reader (delivery, Stop's
/// fence, answer validation); native code sends the person's intent and waits for admission.
extension ClientModel {
    func forkThread(point: String, text: String) async -> Bool {
        guard canOperate, let thread, let item = thread.items[point], item.row.complete, !text.isEmpty else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) {
            command(["type": "thread.fork", "threadId": thread.id, "point": ["type": "item", "itemId": point], "input": text], requestId: id)
        }
    }
    /// Persist a follow-up: `alternate` asks for the other delivery the composer offered.
    /// `reply` is the question card on the strip: the bridge sends the words as its answer when
    /// they can be one (`@ace/ui-core` composerReply), else as a message.
    func sendMessage(_ text: String, alternate: Bool, reply: QuestionReply? = nil) async -> Bool {
        guard canOperate, let thread else { return false }
        // Words, files or both; the bridge checks again with the shared rule.
        guard !thread.screen.attachments.isEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        let id = admissions.nextId()
        var action: [String: Any] = ["type": "send", "text": text, "opposite": alternate, "requestId": id]
        if let reply { action["reply"] = reply.payload }
        return await admissions.wait(id: id) { threadAction(action) }
    }
    /// Stop the whole agent tree of the turn on screen.
    func stopTree() {
        guard canOperate, let thread, thread.screen.controls?.canStop == true, !thread.screen.stopping else { return }
        let id = admissions.nextId()
        thread.screen.stopping = true
        thread.screen.stopRequest = id
        Task { [weak self, weak thread] in
            guard let self else { return }
            let saved = await self.admissions.wait(id: id) { self.threadAction(["type": "stop", "requestId": id]) }
            if !saved { thread?.screen.stopFailed(id) }
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
    /// Pause, resume or clear the thread's goal from its sheet; true once the daemon took it.
    func changeGoal(_ change: String) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) { threadAction(["type": "goal", "change": change, "requestId": id]) }
    }
    @discardableResult func threadAction(_ value: [String: Any]) -> Bool {
        let dispatched = action(threadMessage(value, epoch: nil))
        if !dispatched { error = "Could not submit the request. Your draft is still available." }
        return dispatched
    }
    /// `epoch` names the generation the action is for (the open thread's when nil), so the bridge
    /// drops a closed thread's late releases instead of applying them to another one.
    func threadMessage(_ value: [String: Any], epoch: Int?) -> [String: Any] {
        var message: [String: Any] = ["type": "thread", "action": value]
        if let epoch = epoch ?? thread?.epoch { message["epoch"] = epoch }
        return message
    }
}
