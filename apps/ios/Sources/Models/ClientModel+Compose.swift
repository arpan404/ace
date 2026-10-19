import Foundation

/// New thread, Add project and the Files sheet (`bridge/compose-actions.ts`). Swift sends the
/// person's choices; the bridge decides what can start and what `thread.create` carries.
extension ClientModel {
    @discardableResult func composeAction(_ value: [String: Any]) -> Bool { action(["type": "compose", "action": value]) }
    @discardableResult func filesAction(_ value: [String: Any]) -> Bool { action(["type": "files", "action": value]) }

    /// Save the start in the SDK's outbox under `commandId`: true once it is on this phone.
    /// A view-only machine submits nothing.
    func startThread(_ draft: NewThreadDraft, commandId: String) async -> Bool {
        guard canOperate, let project = draft.projectId,
              !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        var create: [String: Any] = [
            "kind": "create", "commandId": commandId, "workspaceId": project,
            "mode": draft.worktree ? "worktree" : "local", "text": draft.text,
        ]
        if let provider = draft.provider { create["provider"] = provider }
        if let model = draft.model { create["model"] = model }
        if let account = draft.account { create["account"] = account }
        if let effort = draft.effort { create["effort"] = effort }
        if draft.worktree, let base = draft.base {
            create["base"] = base.remote.map { ["ref": base.ref, "remote": $0] } ?? ["ref": base.ref]
        }
        return await admissions.wait(id: commandId) { composeAction(create) }
    }
    /// Register an existing folder as a project; the receipt lands in `compose.added[requestId]`.
    func addProject(path: String, requestId: String) async -> Bool {
        guard canOperate else { return false }
        return await admissions.wait(id: requestId) { composeAction(["kind": "addProject", "path": path, "requestId": requestId]) }
    }
}
