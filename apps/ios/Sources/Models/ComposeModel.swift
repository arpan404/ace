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
    struct Speed: Codable, Sendable, Identifiable, Equatable { let speed: String; let label: String; var id: String { speed } }
    struct Model: Codable, Sendable, Identifiable, Equatable {
        let key: String; let label: String; let account: String
        let efforts: [Effort]; let defaultEffort: String?
        /// Speeds it can start at, slowest first; empty or absent when there's nothing faster.
        var speeds: [Speed]?
        var defaultSpeed: String?
        var id: String { account + "\u{0}" + key }
    }
    let provider: String; let name: String; let ready: Bool
    let status: StatusDisplay
    /// Why it can't start a thread; nil when it can.
    let reason: String?
    let accounts: [Account]; let models: [Model]
    /// How many models show before "More models": the one in use (else the default) leads.
    var lead: Int?
    var id: String { provider }
    var leading: ArraySlice<Model> { models.prefix(lead ?? models.count) }
    var more: ArraySlice<Model> { models.dropFirst(lead ?? models.count) }
}
/// One access mode the chosen agent supports, worded by the shared rules.
struct ComposeAccessChoice: Codable, Sendable, Identifiable, Equatable {
    let mode: String; let label: String; let description: String; let attention: Bool
    var id: String { mode }
}
/// What the thread would run at (`newThreadAccess` in `@ace/ui-core`) and what else it could.
struct ComposeAccess: Codable, Sendable, Equatable {
    let provider: String?; let state: String
    let choices: [ComposeAccessChoice]
    /// The mode it runs as: the one picked, else the project's or daemon's default, stepped down.
    let selected: String?
    let label: String?
    /// Why it runs stricter than the default it follows.
    let stricter: String?
    /// Why Send waits: nothing that strict is supported.
    let problem: String?
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
    case access(ComposeAccess)
    case attachments(workspaceId: String, [AttachmentFile], blocked: String?)

    private enum Keys: String, CodingKey {
        case type, state, projects, providers, start, workspaceId, bases, noWorktree, query, paths, folders, id, ok, threadId, projectId, message
        case files, blocked
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
        case "compose.access": self = .access(try ComposeAccess(from: decoder))
        case "compose.attachments":
            self = .attachments(workspaceId: try box.decode(String.self, forKey: .workspaceId), try box.decode([AttachmentFile].self, forKey: .files),
                                blocked: try box.decodeIfPresent(String.self, forKey: .blocked))
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
    /// The chosen agent's access modes and the one the thread would run at.
    var access: ComposeAccess?
    /// The first message's files, in the chosen project's draft scope, and why they can't go yet.
    var attachments: (workspaceId: String, files: [AttachmentFile], blocked: String?)?

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
        case .access(let read): access = read
        case .attachments(let workspaceId, let files, let blocked): attachments = (workspaceId, files, blocked)
        }
    }
    func reset() {
        projectsState = "idle"; projects = []; agentsState = "idle"; agents = []; start = nil
        branches = nil; mentions = nil; folders = nil; started = [:]; added = [:]; access = nil; attachments = nil
    }
}
