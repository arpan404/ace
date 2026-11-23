import Foundation

/// What a bot may use and where it lives, from its profile (`bridge/spade-requests-profile-actions.ts`).
extension ClientModel {
    typealias Access = SpadeProfileAccess

    func spadeApps(_ agent: String) async -> SpadePart<Access.Apps> {
        await spadePart(["type": "spade.apps", "agentId": agent], as: Access.Apps.self, failing: "Couldn't read its apps")
    }
    func spadeApp(_ agent: String, connector: String, on: Bool) async -> SpadePart<Access.Apps> {
        await spadePart(["type": "spade.app", "agentId": agent, "connector": connector, "on": on],
                        as: Access.Apps.self, failing: "Couldn't change its apps")
    }
    func spadePlugins(_ agent: String) async -> SpadePart<Access.Plugins> {
        await spadePart(["type": "spade.plugins", "agentId": agent], as: Access.Plugins.self,
                        failing: "Couldn't read its plugins")
    }
    func spadePlugin(_ agent: String, name: String, on: Bool) async -> SpadePart<Access.Plugins> {
        await spadePart(["type": "spade.plugin", "agentId": agent, "name": name, "on": on],
                        as: Access.Plugins.self, failing: "Couldn't change its plugins")
    }
    /// The bot's move now, or what needs the person since it arrived; nil `part` for neither.
    func spadeMove(_ agent: String) async -> SpadePart<Access.Move> {
        await spadePart(["type": "spade.move.read", "agentId": agent], as: Access.Move.self,
                        failing: "Couldn't read the move")
    }
    /// Starts moving the bot to the machine with ace host id `to`.
    func spadeMoveStart(_ agent: String, to: String, move: String) async -> SpadePart<Access.Move> {
        await spadePart(["type": "spade.move.start", "agentId": agent, "to": to, "move": move],
                        as: Access.Move.self, failing: "Couldn't move it")
    }
    /// On the machine the bot goes to: the person accepts the move as packed.
    func spadeMoveAccept(_ move: String, accept: Access.Accept) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.move.accept", "move": move, "accept": accept.payload],
                           failing: "Couldn't move it here")
    }
    /// `cancel` (also dismisses a failed move), `check` or `arrival`.
    func spadeMoveEnd(_ agent: String, action: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.move.end", "agentId": agent, "action": action],
                           failing: "Couldn't change the move")
    }
    func spadeDeleteAsk(_ agent: String) async -> SpadePart<Access.Delete> {
        await spadePart(["type": "spade.delete.ask", "agentId": agent], as: Access.Delete.self,
                        failing: "Couldn't read its workers")
    }
    /// Deletes the bot; one that made workers says whether to `stop` or `keep` them.
    func spadeDelete(_ agent: String, workers: String? = nil) async -> SpadeOutcome {
        var payload: [String: Any] = ["type": "spade.delete", "agentId": agent]
        if let workers { payload["workers"] = workers }
        return await spadeRequest(payload, failing: "Couldn't delete it")
    }
}
