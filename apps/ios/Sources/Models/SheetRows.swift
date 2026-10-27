import Foundation

/// The Agents sheet as `@ace/ui-core/mobile` shaped it. Swift draws it; it never derives status.
/// A native subagent as its lane inspects it (`subagentInspection` in ui-core): every word,
/// state and control is the bridge's.
struct SubagentInfo: Codable, Sendable, Equatable {
    struct Parent: Codable, Sendable, Equatable { let agentId: String?; let name: String }
    /// What the parent asked, drawn as the person's bubble.
    struct Prompt: Codable, Sendable, Equatable { let bubble: BubbleLine; let at: Double }
    struct Retry: Codable, Sendable, Equatable { let label: String }
    let agentId: String
    let name: String
    let provider: String
    let model: String
    let parent: Parent
    let prompt: Prompt?
    /// running, human, stalled, done, failed or stopped.
    let phase: String
    let status: StatusDisplay
    let startedAt: Double
    let endedAt: Double?
    let requests: [String]
    let descendants: Int
    let stoppable: Bool
    let retry: Retry?
    let parentBusy: Bool
}

struct AgentSheet: Codable, Sendable, Equatable {
    struct Row: Codable, Sendable, Equatable, Identifiable {
        let id: String
        let parentId: String?
        let depth: Int
        let name: String
        let model: String
        let status: StatusDisplay
        let activity: String
        let running: Bool
        let needsYou: Bool
        let tokens: Int?
        let costUsd: Double?
        let childThreadId: String?
        let descendants: Int
        let stoppable: Bool
        let background: Bool
        let createdAt: Double
        let endedAt: Double?
    }
    struct BackgroundTask: Codable, Sendable, Equatable, Identifiable {
        let id: String
        let agentId: String
        let kind: String
        let title: String
        let status: StatusDisplay
        let stoppable: Bool
        let startedAt: Double
        let endedAt: Double?
    }
    struct Hidden: Codable, Sendable, Equatable { let agents: Int; let running: Int }
    struct Totals: Codable, Sendable, Equatable {
        let agents: Int; let running: Int; let needsYou: Int; let tokens: Int?; let costUsd: Double?
    }
    struct Context: Codable, Sendable, Equatable { let used: Int; let window: Int }
    let rows: [Row]
    let hidden: Hidden
    let tasks: [BackgroundTask]
    let hiddenTasks: Int
    let totals: Totals
    let context: Context?
    let treeRunning: Bool
}

/// The Changes sheet's file list and next step, read by the bridge from the daemon's guarded git.
struct ChangesSummary: Codable, Sendable, Equatable {
    struct File: Codable, Sendable, Equatable, Identifiable {
        let path: String; let from: String?; let status: String
        let additions: Int; let deletions: Int; let binary: Bool
        var id: String { path }
    }
    struct Totals: Codable, Sendable, Equatable { let files: Int; let additions: Int; let deletions: Int }
    struct Step: Codable, Sendable, Equatable {
        struct PullRequest: Codable, Sendable, Equatable { let number: Int; let url: String?; let state: String; let title: String? }
        /// `commit`, `push`, `create-pr`, `merge` or `none`.
        let kind: String
        let label: String
        let detail: String
        let blocked: String?
        let pr: PullRequest?
    }
    /// `loading`, `ready` or `error` (with the daemon's refusal code in `message`).
    let state: String
    let message: String
    let files: [File]
    let hidden: Int
    let partial: Bool
    let totals: Totals
    let patchTruncated: Bool
    let branch: String
    let step: Step
    let busy: Bool
    /// Merge methods to pick from; the first is the default until the person picks one.
    let methods: [MergeMethodOption]?
}

/// One file's unified diff within the shared budget; `truncated` sends the rest to the computer.
struct FileDiff: Codable, Sendable, Equatable {
    struct Line: Codable, Sendable, Equatable {
        /// `add`, `del`, `context` or `hunk`.
        let kind: String
        let old: Int?
        let new: Int?
        let text: String
        let clipped: Bool
    }
    let lines: [Line]
    let hiddenLines: Int
    let truncated: Bool
    let empty: Bool
}

/// A git step's outcome, correlated by request id.
struct GitOutcome: Sendable, Equatable { let ok: Bool; let message: String }

/// One way the forge merges a PR (`mergeMethods` in `@ace/ui-core`).
struct MergeMethodOption: Codable, Sendable, Equatable, Identifiable {
    let method: String
    let label: String
    var id: String { method }
}

/// The AI draft of a commit message or PR title and summary (`bridge/git-drafts.ts`), by request id.
struct GitDraft: Codable, Sendable, Equatable {
    let id: String
    /// `commit` or `create-pr`.
    let `for`: String
    /// `drafting`, `ready`, `failed` or `cancelled`.
    let state: String
    let subject: String?
    let body: String?
    let message: String?
}
