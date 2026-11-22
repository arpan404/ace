import Foundation

/// A bot's profile sheet: read it and save its task (`bridge/spade-requests-profile.ts`).
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
}
