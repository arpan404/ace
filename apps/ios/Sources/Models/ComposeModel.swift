import Foundation
import Observation

/// A project on the machine, recent ones first (`newThreadProjects` in `@ace/ui-core/mobile`).
struct ComposeProject: Codable, Sendable, Identifiable, Equatable {
    let id: String; let name: String; let path: String; let recent: Bool
}
/// A coding agent on the machine, worded and judged by the bridge: Swift never decides readiness.
struct ComposeAgent: Codable, Sendable, Identifiable, Equatable {
    struct Account: Codable, Sendable, Identifiable, Equatable { let id: String; let label: String; let usage: String }
    struct Effort: Codable, Sendable, Identifiable, Equatable { let id: String; let label: String }
    struct Model: Codable, Sendable, Identifiable, Equatable {
        let key: String; let label: String; let account: String
        let efforts: [Effort]; let defaultEffort: String?
        var id: String { account + "\u{0}" + key }
    }
    let provider: String; let name: String; let ready: Bool
    let status: StatusDisplay
    /// Why it can't start a thread; nil when it can.
    let reason: String?
    let accounts: [Account]; let models: [Model]
    var id: String { provider }
}
/// What a thread starts on when nothing is picked.
struct ComposeChoice: Codable, Sendable, Equatable { let provider: String; let model: String; let account: String; let effort: String? }
struct ComposeBase: Codable, Sendable, Hashable, Identifiable {
    let ref: String; let remote: String?; let label: String; let note: String?
    var id: String { label }
    /// "origin/main · default".
    var title: String { if let note { return label + " · " + note }; return label }
    var base: ComposeBaseRef { ComposeBaseRef(ref: ref, remote: remote) }
}
struct ComposeBaseRef: Codable, Sendable, Hashable { let ref: String; let remote: String? }
struct ComposeFolder: Codable, Sendable, Identifiable, Equatable {
    let name: String; let path: String; let project: Bool; let git: Bool
    var id: String { path }
}
struct ComposeOutcome: Sendable, Equatable { let ok: Bool; let id: String?; let message: String }

/// `compose.*` patches from `bridge/new-thread.ts` and `bridge/compose-search.ts`.
enum ComposePatch: Decodable, Sendable {
    case projects(state: String, [ComposeProject])
    case agents(state: String, [ComposeAgent], start: ComposeChoice?)
    case branches(workspaceId: String, state: String, [ComposeBase], start: ComposeBaseRef?, noWorktree: String?)
    case mentions(workspaceId: String, query: String, state: String, [String])
    case folders(query: String, state: String, [ComposeFolder])
    case started(id: String, ComposeOutcome)
    case added(id: String, ComposeOutcome)

    private enum Keys: String, CodingKey {
        case type, state, projects, providers, start, workspaceId, bases, noWorktree, query, paths, folders, id, ok, threadId, projectId, message
    }
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        func state() throws -> String { try box.decode(String.self, forKey: .state) }
        switch try box.decode(String.self, forKey: .type) {
        case "compose.projects": self = .projects(state: try state(), try box.decode([ComposeProject].self, forKey: .projects))
        case "compose.agents":
            self = .agents(state: try state(), try box.decode([ComposeAgent].self, forKey: .providers),
                           start: try box.decodeIfPresent(ComposeChoice.self, forKey: .start))
        case "compose.branches":
            self = .branches(workspaceId: try box.decode(String.self, forKey: .workspaceId), state: try state(),
                             try box.decode([ComposeBase].self, forKey: .bases),
                             start: try box.decodeIfPresent(ComposeBaseRef.self, forKey: .start),
                             noWorktree: try box.decodeIfPresent(String.self, forKey: .noWorktree))
        case "compose.mentions":
            self = .mentions(workspaceId: try box.decode(String.self, forKey: .workspaceId), query: try box.decode(String.self, forKey: .query),
                             state: try state(), try box.decode([String].self, forKey: .paths))
        case "compose.folders":
            self = .folders(query: try box.decode(String.self, forKey: .query), state: try state(), try box.decode([ComposeFolder].self, forKey: .folders))
        case "compose.start":
            self = .started(id: try box.decode(String.self, forKey: .id),
                            ComposeOutcome(ok: try box.decode(Bool.self, forKey: .ok), id: try box.decodeIfPresent(String.self, forKey: .threadId),
                                           message: try box.decode(String.self, forKey: .message)))
        case "compose.added":
            self = .added(id: try box.decode(String.self, forKey: .id),
                          ComposeOutcome(ok: try box.decode(Bool.self, forKey: .ok), id: try box.decodeIfPresent(String.self, forKey: .projectId),
                                         message: try box.decode(String.self, forKey: .message)))
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: box, debugDescription: "Unknown compose patch")
        }
    }
}

/// One machine's New thread and Add project reads, as the bridge last sent them.
@MainActor @Observable final class ComposeModel {
    var projectsState = "idle"
    var projects: [ComposeProject] = []
    var agentsState = "idle"
    var agents: [ComposeAgent] = []
    var start: ComposeChoice?
    var branches: (workspaceId: String, state: String, bases: [ComposeBase], start: ComposeBaseRef?, noWorktree: String?)?
    var mentions: (workspaceId: String, query: String, state: String, paths: [String])?
    var folders: (query: String, state: String, folders: [ComposeFolder])?
    /// Daemon receipts by command id: the thread a start made, or why it didn't.
    var started: [String: ComposeOutcome] = [:]
    var added: [String: ComposeOutcome] = [:]

    func apply(_ patch: ComposePatch) {
        switch patch {
        case .projects(let state, let rows): projectsState = state; projects = rows
        case .agents(let state, let rows, let choice): agentsState = state; agents = rows; start = choice
        case .branches(let workspaceId, let state, let bases, let start, let noWorktree):
            branches = (workspaceId, state, bases, start, noWorktree)
        case .mentions(let workspaceId, let query, let state, let paths): mentions = (workspaceId, query, state, paths)
        case .folders(let query, let state, let rows): folders = (query, state, rows)
        case .started(let id, let outcome): started[id] = outcome
        case .added(let id, let outcome): added[id] = outcome
        }
    }
    func reset() {
        projectsState = "idle"; projects = []; agentsState = "idle"; agents = []; start = nil
        branches = nil; mentions = nil; folders = nil; started = [:]; added = [:]
    }
}
