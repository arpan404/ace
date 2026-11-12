import Foundation

/// The open thread's Summary as the bridge words it (`bridge/thread-summary-view.ts`): Now,
/// Since you looked, the agent tree's count, Results, the plan and the project's automations. Each list is empty, and each
/// optional nil, when its section has nothing to say; Swift only draws and routes.
struct ThreadSummarySheet: Codable, Sendable, Equatable {
    struct Now: Codable, Sendable, Equatable {
        struct Open: Codable, Sendable, Equatable {
            let threadId: String
            let agentId: String
            let childThreadId: String?
            let name: String
        }
        let say: String
        let lead: String
        /// The muted time after the lead ("17m"); nil when the headline stands alone.
        let span: String?
        let sub: String
        /// plain, needs-you or failed.
        let tone: String
        let speak: String
        let open: Open?
    }
    struct Line: Codable, Sendable, Equatable, Identifiable {
        let text: String
        let tone: String
        var id: String { text }
    }
    struct PullRequest: Codable, Sendable, Equatable, Identifiable {
        let id: String
        let title: String
        let line: String
        let url: String
        let number: Int
        let repository: ForgeRepository
    }
    struct Files: Codable, Sendable, Equatable {
        let title: String
        let detail: String
        let conflicts: [String]
    }
    struct Check: Codable, Sendable, Equatable, Identifiable {
        let text: String
        let failed: Bool
        var id: String { text }
    }
    struct Commands: Codable, Sendable, Equatable {
        let ran: String
        let failed: String
    }
    struct Plan: Codable, Sendable, Equatable {
        struct Todo: Codable, Sendable, Equatable, Identifiable {
            let id: String
            let text: String
            /// pending, in_progress, completed or cancelled.
            let status: String
            /// The status in words, for VoiceOver.
            let words: String
        }
        let count: String
        let done: Int
        let total: Int
        let todos: [Todo]
    }
    /// The project's schedules in one line opening Automations; `failed` when the read failed, and
    /// a tap reads again.
    struct Automations: Codable, Sendable, Equatable {
        let line: String
        let failed: Bool
    }
    /// The thread's project, where its pull requests open.
    let workspaceId: String
    let now: Now
    let catchUp: [Line]
    let agents: String?
    let prs: [PullRequest]
    let prFold: String?
    let files: Files?
    let checks: [Check]
    let commands: Commands?
    let plan: Plan?
    /// Nil when the project has none, and from older bridges.
    var automations: Automations? = nil

    /// Results has a pull request, changed files, a check or a failed command to show.
    var hasResults: Bool { !prs.isEmpty || prFold != nil || files != nil || !checks.isEmpty || commands != nil }
}
