import Foundation

/// Plan reviews, forms and browser requests; effort and speed; attachments; finished steps;
/// subagent lanes; queue order. Native code sends intent only. The bridge validates each choice
/// against the request or the catalog and builds the payload. View-only machines send nothing.
extension ClientModel {
    /// Answer a plan review, form or browser request. Like approvals, the card waits for the
    /// daemon's canonical close after durable admission; a refusal gives the controls back.
    func resolve(_ interaction: ApprovalRow, answer: [String: Any]) {
        guard canOperate, interaction.state == "pending", approvalSubmissions[interaction.id] == nil else { return }
        let id = admissions.nextId()
        approvalSubmissions[interaction.id] = ApprovalSubmission(requestId: id, phase: .saving)
        approvalRequests[id] = interaction.id
        if !threadAction(["type": "resolve", "interactionId": interaction.id, "answer": answer, "requestId": id]) {
            approvalSubmissions[interaction.id] = nil
            approvalRequests[id] = nil
        }
    }
    /// Effort for the next message; nil goes back to the model's default.
    func setEffort(_ effort: String?) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) { threadAction(["type": "effort", "effort": effort ?? NSNull(), "requestId": id]) }
    }
    /// The thread's access from the agent's next turn.
    func setAccess(_ mode: String) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) { threadAction(["type": "access", "mode": mode, "requestId": id]) }
    }
    func setSpeed(_ speed: String) async -> Bool {
        guard canOperate else { return false }
        let id = admissions.nextId()
        return await admissions.wait(id: id) { threadAction(["type": "speed", "speed": speed, "requestId": id]) }
    }
    /// Move a queued follow-up one place up (-1) or down (1).
    func moveQueued(_ message: QueueRow.Message, step: Int) async -> Bool {
        await editQueued(message, change: ["kind": "move", "step": step])
    }
    /// Put a staged file on the next message; the bridge checks limits and uploads it.
    func attach(_ file: StagedAttachment) {
        guard canOperate else { return }
        threadAction(["type": "attach", "file": file.json])
    }
    /// Take a browser annotation off the next message; the rest close ranks, on the page too.
    func removeAnnotation(_ id: String) { threadAction(["type": "annotation.remove", "id": id]) }
    func clearAnnotations() { threadAction(["type": "annotation.clear"]) }
    func detach(_ localId: String) {
        threadAction(["type": "detach", "localId": localId])
        AttachmentStaging().discard(localId)
    }
    /// A settled "Worked for" log opened: read its turn's full steps; closed: let them go.
    func openSteps(ordinal: Int, block: String) { threadAction(["type": "steps.open", "ordinal": ordinal, "block": block]) }
    /// `epoch` is the generation whose log closed: the view can disappear after the person left
    /// that thread, and its release must not close another generation's log.
    func closeSteps(ordinal: Int, epoch: Int? = nil) { releaseAction(["type": "steps.close", "ordinal": ordinal], epoch: epoch) }
    func moreSteps(ordinal: Int) { threadAction(["type": "steps.more", "ordinal": ordinal]) }
    /// A native subagent's lane sheet opened or closed.
    func openLane(_ agentId: String) {
        guard let thread else { return }
        thread.screen.lane = LaneModel(agentId: agentId)
        threadAction(["type": "lane.open", "agentId": agentId])
    }
    func closeLane(epoch: Int? = nil) {
        if epoch == nil || thread?.epoch == epoch { thread?.screen.lane = nil }
        releaseAction(["type": "lane.close"], epoch: epoch)
    }
    /// Letting go of a read: with no runtime there is nothing to release, so it is never an error.
    private func releaseAction(_ value: [String: Any], epoch: Int?) { action(threadMessage(value, epoch: epoch)) }
}
