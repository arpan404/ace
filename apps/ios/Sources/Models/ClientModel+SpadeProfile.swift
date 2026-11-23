import Foundation

/// A bot's profile sheet (`bridge/spade-requests-profile.ts`): read it and save its task, and
/// each tab's own reads and writes.
extension ClientModel {
    /// A bot's profile, read afresh.
    func spadeProfile(_ agent: String) async -> SpadeProfileAnswer {
        let failed = { (message: String?) in
            SpadeProfileAnswer(ok: false, profile: nil, title: "Couldn't read the profile", message: message)
        }
        do {
            return try await service(["type": "spade.profile", "agentId": agent], as: SpadeProfileAnswer.self,
                                     timeout: .seconds(30))
        } catch is CancellationError { return failed(nil) }
        catch { return failed(error.localizedDescription) }
    }
    /// The bot's task, as the person rewrote it.
    func spadeTask(_ agent: String, task: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.task", "agentId": agent, "task": task], failing: "Couldn't save the task")
    }
    /// A tab's read or write; a transport failure reads as a refusal with its words.
    func spadePart<Value: Decodable & Sendable>(_ payload: [String: Any], as type: Value.Type,
                                                failing title: String) async -> SpadePart<Value> {
        do { return try await service(payload, as: SpadePart<Value>.self, timeout: .seconds(30)) }
        catch is CancellationError { return SpadePart(ok: false) }
        catch { return SpadePart(ok: false, title: title, message: error.localizedDescription) }
    }
    /// The Permissions tab's switches.
    func spadePermissions(_ agent: String) async -> SpadePart<SpadePermissions> {
        await spadePart(["type": "spade.permissions", "agentId": agent], as: SpadePermissions.self,
                        failing: "Couldn't read its permissions")
    }
    /// One switch on or off; nil goes back to the default in Settings › Spade › Security.
    func spadePermission(_ agent: String, key: String, on: Bool?) async -> SpadePart<SpadePermissions> {
        let payload: [String: Any] = ["type": "spade.permission", "agentId": agent, "key": key,
                                      "on": on.map { $0 as Any } ?? NSNull()]
        return await spadePart(payload, as: SpadePermissions.self, failing: "Couldn't change the permission")
    }
    /// The Work tab: the goal and plan, the workers and the decisions.
    func spadeWork(_ agent: String) async -> SpadePart<SpadeWork> {
        await spadePart(["type": "spade.work", "agentId": agent], as: SpadeWork.self, failing: "Couldn't read its work")
    }
}
