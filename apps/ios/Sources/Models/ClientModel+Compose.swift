import Foundation

/// New thread, Add project and the Files sheet (`bridge/compose-actions.ts`). Swift sends the
/// person's choices; the bridge decides what can start and what `thread.create` carries.
extension ClientModel {
    @discardableResult func composeAction(_ value: [String: Any]) -> Bool { action(["type": "compose", "action": value]) }
    @discardableResult func filesAction(_ value: [String: Any]) -> Bool { action(["type": "files", "action": value]) }

    /// Save the start in the SDK's outbox under `commandId`: true once it is on this phone.
    /// A view-only machine submits nothing.
    func startThread(_ draft: NewThreadDraft, commandId: String) async -> Bool {
        guard canOperate, let project = draft.projectId else { return false }
        let files = compose.attachments?.workspaceId == project ? compose.attachments?.files.count ?? 0 : 0
        // Words, files or both; the bridge checks again with the shared rule.
        guard files > 0 || !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        var create: [String: Any] = [
            "kind": "create", "commandId": commandId, "workspaceId": project,
            "mode": draft.worktree ? "worktree" : "local", "text": draft.outgoingText,
        ]
        if let provider = draft.provider { create["provider"] = provider }
        if let model = draft.model { create["model"] = model }
        if let account = draft.account { create["account"] = account }
        if let effort = draft.effort { create["effort"] = effort }
        if let speed = draft.speed { create["speed"] = speed }
        if let access = draft.access { create["access"] = access }
        if draft.worktree, let base = draft.base {
            create["base"] = base.remote.map { ["ref": base.ref, "remote": $0] } ?? ["ref": base.ref]
        }
        return await admissions.wait(id: commandId) { composeAction(create) }
    }
    /// What the sheet has chosen so far: the picker leads with it and its access modes are read.
    func composeChoice(_ draft: NewThreadDraft) {
        var choice: [String: Any] = ["kind": "choice"]
        if let project = draft.projectId { choice["workspaceId"] = project }
        if let provider = draft.provider { choice["provider"] = provider }
        if let model = draft.model { choice["model"] = model }
        if let account = draft.account { choice["account"] = account }
        if let access = draft.access { choice["access"] = access }
        composeAction(choice)
    }
    /// A file picked for the first message: the bridge checks it and uploads it into the project.
    func composeAttach(_ file: StagedAttachment, workspaceId: String) {
        guard canOperate else { return }
        composeAction(["kind": "attach", "workspaceId": workspaceId, "file": file.json])
    }
    func composeDetach(_ localId: String) {
        composeAction(["kind": "detach", "localId": localId])
        AttachmentStaging().discard(localId)
    }
    /// Register an existing folder as a project; the receipt lands in `compose.added[requestId]`.
    func addProject(path: String, requestId: String) async -> Bool {
        guard canOperate else { return false }
        return await admissions.wait(id: requestId) { composeAction(["kind": "addProject", "path": path, "requestId": requestId]) }
    }
    func createProject(_ draft: ProjectCreationDraft, cloning: Bool, requestId: String) async -> Bool {
        guard canOperate else { return false }
        var payload: [String: Any] = ["type": cloning ? "workspace.clone" : "workspace.create", "parent": draft.parent, "name": draft.name]
        if cloning { payload["url"] = draft.url }
        else if draft.git {
            payload["git"] = draft.branch.isEmpty ? [:] : ["initialBranch": draft.branch]
            if !draft.gitignore.isEmpty { payload["gitignore"] = draft.gitignore }
        }
        return await admissions.wait(id: requestId) { composeAction(["kind": "createProject", "payload": payload, "requestId": requestId]) }
    }
}
