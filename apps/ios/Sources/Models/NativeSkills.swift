import Foundation

/// The skill library as `bridge/skill-library.ts` sends it: rows and pages with their words
/// already written, so these views only draw.
struct SkillRow: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let title: String
    let description: String
    let marks: [String]
    let editable: Bool
}
struct SkillGroup: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let rows: [SkillRow]
}
struct SkillLibrary: Decodable, Equatable {
    let groups: [SkillGroup]
    let stale: Bool
}
struct SkillAgentChoice: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    var on: Bool
    let locked: Bool
}
struct SkillRunsChoice: Decodable, Hashable {
    let manual: Bool
    let label: String
}
struct SkillPage: Decodable, Equatable {
    struct LastUse: Decodable, Equatable { let threadId: String; let title: String; let ago: String }
    let id: String
    let title: String
    let description: String
    let editable: Bool
    let hash: String
    let agentsText: String
    let agents: [SkillAgentChoice]
    let savedIn: String
    let path: String?
    let manual: Bool
    let runs: String
    let runsChoices: [SkillRunsChoice]
    let argumentHint: String?
    let used: String
    let last: LastUse?
    let instructions: String
    let body: String
    let deleteMessage: String
    /// Where Open on computer opens the skill; null until the host can open it.
    let open: SkillHostTarget?
}
struct SkillHostTarget: Decodable, Equatable { let workspaceId: String; let path: String }
struct SkillDraftChoices: Decodable {
    let agents: [SkillAgentChoice]
    let runs: [SkillRunsChoice]
}
struct SkillNameCheck: Decodable { let problem: String?; let path: String }
struct SkillCreated: Decodable { let id: String }
struct SkillSaved: Decodable { let hash: String }
struct SkillAgentsSaved: Decodable { let hash: String; let note: String? }

/// A refusal from the skill library. `unreachable` means the change may or may not have reached
/// the machine: the next send of it says `retry`, and the bridge recognises its own change.
struct SkillFailure: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }
    var uncertain: Bool { code == "unreachable" }
}
private struct SkillOutcome: Decodable { let ok: Bool; let code: String?; let message: String? }

extension ClientModel {
    /// One `skills.native` request; the reply decoded as `T`, or its refusal thrown.
    func skills<T: Decodable>(_ operation: [String: Any], as type: T.Type) async throws -> T {
        do {
            let value = try await service(operation.merging(["type": "skills.native"]) { $1 }, as: ServiceValue.self)
            return try skillAnswer(value, as: type)
        } catch let failure as SkillFailure { throw failure }
        catch is CancellationError { throw CancellationError() }
        catch { throw SkillFailure(code: "unreachable", message: "Couldn't reach the machine. Your changes are still here; try again.") }
    }
    /// The library list, kept between visits (`bridge/read-policy.ts`).
    func skillLibrary(_ payload: [String: Any]) async throws -> SkillLibrary {
        try skillAnswer(try await read(payload, as: ServiceValue.self), as: SkillLibrary.self)
    }
    func keptSkillLibrary(_ payload: [String: Any]) -> SkillLibrary? {
        kept(payload, as: ServiceValue.self).flatMap { try? skillAnswer($0, as: SkillLibrary.self) }
    }
    /// One `plugins.native` request (`bridge/skill-plugins.ts`).
    func pluginAgents<T: Decodable>(_ operation: [String: Any], as type: T.Type) async throws -> T {
        let value = try await service(operation.merging(["type": "plugins.native"]) { $1 }, as: ServiceValue.self)
        return try skillAnswer(value, as: type)
    }
    /// Every project on the machine, for choosing whose skills to show.
    func allProjects() async throws -> [NativeProject] {
        var after: String?
        var all: [NativeProject] = []
        for _ in 0..<10 {
            var operation: [String: Any] = ["op": "workspace.list", "limit": 100]
            if let after { operation["after"] = after }
            let reply = try await service(["type": "projects.request", "operation": operation], as: ProjectListReply.self)
            guard reply.result.kind == "projects" else { throw ServiceFailure(message: "This pairing needs Projects access to show project skills.") }
            all += reply.result.projects ?? []
            after = reply.result.next
            if after == nil { break }
        }
        return all
    }
}

private func skillAnswer<T: Decodable>(_ value: ServiceValue, as type: T.Type) throws -> T {
    let outcome = try value.decode(SkillOutcome.self)
    guard outcome.ok else { throw SkillFailure(code: outcome.code ?? "unavailable", message: outcome.message ?? "The machine refused that.") }
    return try value.decode(type)
}

/// A plugin's agents as `bridge/skill-plugins.ts` sends them.
struct PluginAgents: Decodable, Identifiable, Equatable {
    struct Agent: Decodable, Identifiable, Equatable { let id: String; let name: String; let on: Bool }
    let name: String
    let version: String
    let on: Bool
    let enabled: Bool
    let summary: String
    let agents: [Agent]
    var id: String { name }
}
struct PluginAgentsList: Decodable { let plugins: [PluginAgents] }
struct PluginAgentsChanged: Decodable { let plugin: PluginAgents }
