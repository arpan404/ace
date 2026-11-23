import Foundation

/// What the person edits on a bot's profile beyond its task
/// (`bridge/spade-requests-profile-details.ts`); each answers what the section shows now.
extension ClientModel {
    typealias Edits = SpadeProfileEdits

    func spadeDetails(_ agent: String) async -> SpadePart<Edits.Details> {
        await spadePart(["type": "spade.details", "agentId": agent], as: Edits.Details.self,
                        failing: "Couldn't read its details")
    }
    func spadePersonality(_ agent: String, _ personality: Edits.Personality) async -> SpadePart<Edits.Personality> {
        let payload: [String: Any] = ["type": "spade.personality", "agentId": agent,
                                      "tone": personality.tone.map { $0 as Any } ?? NSNull(),
                                      "humour": personality.humour, "emoji": personality.emoji]
        return await spadePart(payload, as: Edits.Personality.self, failing: "Couldn't save its personality")
    }
    func spadeRoles(_ agent: String) async -> SpadePart<Edits.Roles> {
        await spadePart(["type": "spade.roles", "agentId": agent], as: Edits.Roles.self,
                        failing: "Couldn't read the models for other work")
    }
    /// One role to `model`, or "" to follow Settings.
    func spadeRole(_ agent: String, role: String, model: String) async -> SpadePart<Edits.Roles> {
        await spadePart(["type": "spade.role", "agentId": agent, "role": role, "model": model],
                        as: Edits.Roles.self, failing: "Couldn't change the model")
    }
    func spadeReach(_ agent: String, notify: Bool? = nil, approvals: String? = nil) async -> SpadePart<Edits.Reach> {
        var payload: [String: Any] = ["type": "spade.reach", "agentId": agent]
        if let notify { payload["notify"] = notify }
        if let approvals { payload["approvals"] = approvals }
        return await spadePart(payload, as: Edits.Reach.self, failing: "Couldn't change its notifications")
    }
    func spadeNetwork(_ agent: String) async -> SpadePart<Edits.Network> {
        await spadePart(["type": "spade.network", "agentId": agent], as: Edits.Network.self,
                        failing: "Couldn't read its network rules")
    }
    func spadeNetwork(_ agent: String, which: String, change: Edits.NetworkChange) async -> SpadePart<Edits.Network> {
        await spadePart(["type": "spade.network.set", "agentId": agent, "which": which, "change": change.payload],
                        as: Edits.Network.self, failing: "Couldn't change its network rule")
    }
    func spadeCheckpoints(_ agent: String) async -> SpadePart<[Edits.Checkpoint]> {
        await spadePart(["type": "spade.checkpoints", "agentId": agent], as: [Edits.Checkpoint].self,
                        failing: "Couldn't read its checkpoints")
    }
    func spadeRestore(_ agent: String, checkpoint: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.restore", "agentId": agent, "checkpoint": checkpoint],
                           failing: "Couldn't restore the checkpoint")
    }
}
