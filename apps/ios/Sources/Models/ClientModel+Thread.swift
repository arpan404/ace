import Foundation

/// Thread-screen actions. The bridge builds every payload from the SDK reader (delivery, Stop's
/// fence, answer validation); native code sends the person's intent and waits for admission.
extension ClientModel {
    /// Persist a follow-up: `alternate` asks for the other delivery the composer offered.
    /// `reply` is the question card on the strip: the bridge sends the words as its answer when
    /// they can be one (`@ace/ui-core` composerReply), else as a message.
    func sendMessage(_ text: String, alternate: Bool, reply: QuestionReply? = nil, references: [Any] = []) async -> Bool {
        guard canOperate, let thread else { return false }
        // Words, files or both; the bridge checks again with the shared rule.
        guard !thread.screen.attachments.isEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        let id = admissions.nextId()
        // A message that starts a new thread keeps its words and files until the daemon has
        // started it: a refusal leaves the draft as it was, with the refusal's words.
        let continues = thread.screen.controls?.continues == true
        var action: [String: Any] = ["type": "send", "text": text, "opposite": alternate, "continues": continues, "requestId": id]
        if let reply { action["reply"] = reply.payload }
        if !references.isEmpty { action["references"] = references }
        guard continues else { return await admissions.wait(id: id) { threadAction(action) } }
        let refused = await receipts.wait(id: id) { threadAction(action) }
        if let refused { error = refused }
        return refused == nil
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
    func requestModels() { threadAction(["type": "models"]) }
    /// Star or unstar a model by its picker key, where the web keeps stars.
    func favoriteModel(_ key: String) { threadAction(["type": "favorite", "key": key]) }
    /// Move the thread to a model on one account; `confirmed` once the person answered the row's
    /// question. The bridge decides what that does: switch, or continue with the next message.
    func switchModel(key: String, account: String, confirmed: Bool) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) {
            threadAction(["type": "switchModel", "key": key, "account": account, "confirmed": confirmed, "requestId": id])
        }
    }
    /// Change a queued follow-up: `change` is remove, steer (send it now) or new words.
    func editQueued(_ message: QueueRow.Message, change: [String: Any]) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) {
            threadAction(["type": "queue", "messageId": message.id, "change": change, "requestId": id])
        }
    }
    /// A queue-wide choice (Pause queue, Resume, Continue, a limit's choice): the bridge fences it
    /// to the queue as the daemon has it now.
    func actOnQueue(_ choice: QueueRow.Action) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        var action: [String: Any] = ["id": choice.id, "label": choice.label]
        if let instance = choice.instanceId { action["instanceId"] = instance }
        return await admissions.wait(id: id) { threadAction(["type": "queueAct", "action": action, "requestId": id]) }
    }
    /// A message the person sent in the thread, `older` 0 the latest (`bridge/sent-prompt.ts`).
    func sentText(_ threadId: String, older: Int) async -> String? {
        struct Reply: Decodable { let text: String? }
        return try? await service(["type": "thread.sentText", "threadId": threadId, "older": older], as: Reply.self).text
    }
    /// A queued message's full words, read from the daemon's queue, for the edit sheet.
    func queuedWords(_ messageId: String) async -> WordsRequests.Answer {
        guard canOperate else { return WordsRequests.unsent }
        let id = admissions.nextId()
        return await wordRequests.wait(id: id) { threadAction(["type": "queueWords", "messageId": messageId, "requestId": id]) }
    }
    /// New words for a queued message, in place, fenced to the queue `revision` they were read at:
    /// nil once the daemon took them, else why not (the message stays as it was).
    func editQueuedWords(_ messageId: String, text: String, revision: Int?) async -> String? {
        guard canOperate else { return "This phone can only view this machine." }
        let id = admissions.nextId()
        return await receipts.wait(id: id) {
            var change: [String: Any] = ["kind": "words", "text": text]
            if let revision { change["revision"] = revision }
            return threadAction(["type": "queue", "messageId": messageId, "change": change, "requestId": id])
        }
    }
    /// A failed send's full words, for the edit sheet.
    func sendWords(_ commandId: String) async -> WordsRequests.Answer {
        guard canOperate else { return WordsRequests.unsent }
        let id = admissions.nextId()
        return await wordRequests.wait(id: id) {
            action(["type": "inbox", "action": ["kind": "sendWords", "commandId": commandId], "requestId": id])
        }
    }
    /// New words for a failed send, saved in place in the outbox: nil once saved, else why not (the
    /// original stays). Retry then sends them.
    func editFailedSend(_ commandId: String, text: String) async -> String? {
        guard canOperate else { return "This phone can only view this machine." }
        let id = admissions.nextId()
        let answer = await wordRequests.wait(id: id) {
            action(["type": "inbox", "action": ["kind": "editSend", "commandId": commandId, "text": text], "requestId": id])
        }
        return answer.ok ? nil : answer.message
    }
    /// The queue's list shows its next page.
    func showMoreQueued() { threadAction(["type": "queueMore"]) }
    /// Pause, resume or clear a thread's goal from its sheet, for the navigation generation the
    /// sheet was opened on (`epoch`): a sheet left over from a thread the person has since left is
    /// refused by the bridge, never applied to the thread open now. Resolves once the daemon took
    /// it (nil) or refused it (its words).
    func changeGoal(_ change: String, epoch: Int) async -> String? {
        guard canOperate else { return "This phone can only view this machine." }
        let id = admissions.nextId()
        return await receipts.wait(id: id) {
            action(threadMessage(["type": "goal", "change": change, "requestId": id], epoch: epoch))
        }
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
