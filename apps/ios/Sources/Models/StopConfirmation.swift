import Foundation
import Observation

/// Stop in the Agents sheet. Stopping the whole tree, or an agent with subagents under it,
/// asks first; nothing is sent until the person confirms. The outcome is the SDK's durable
/// admission, never a guess that the agents stopped: their canonical status says that.
@MainActor @Observable final class StopConfirmation {
    enum Target: Equatable {
        case tree(agents: Int)
        case agent(id: String, name: String, descendants: Int)
        var agentId: String? { if case .agent(let id, _, _) = self { id } else { nil } }
        var asks: Bool {
            switch self {
            case .tree: true
            case .agent(_, _, let descendants): descendants > 0
            }
        }
        var title: String {
            switch self {
            case .tree: "Stop every agent?"
            case .agent(_, let name, let descendants):
                "Stop \(name) and \(descendants) \(descendants == 1 ? "subagent" : "subagents")?"
            }
        }
        var message: String {
            switch self {
            case .tree(let agents):
                "\(agents) \(agents == 1 ? "agent" : "agents") and their background work stop. Their work so far stays in the thread."
            case .agent: "Their work so far stays in the thread."
            }
        }
    }
    enum Phase: Equatable { case idle, asking(Target), saving(Target), admitted(Target), failed(Target) }
    private(set) var phase: Phase = .idle
    var asking: Target? { if case .asking(let target) = phase { target } else { nil } }
    var saving: Bool { if case .saving = phase { true } else { false } }

    /// Ask first when the stop reaches more than one agent; otherwise stop right away.
    func request(_ target: Target, send: (Target) async -> Bool) async {
        guard !saving else { return }
        if target.asks { phase = .asking(target); return }
        await run(target, send: send)
    }
    func confirm(send: (Target) async -> Bool) async {
        guard let target = asking else { return }
        await run(target, send: send)
    }
    func cancel() { if asking != nil { phase = .idle } }
    private func run(_ target: Target, send: (Target) async -> Bool) async {
        phase = .saving(target)
        phase = await send(target) ? .admitted(target) : .failed(target)
    }
}
