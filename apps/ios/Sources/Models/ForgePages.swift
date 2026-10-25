import Foundation

/// One pull request's page (`bridge/forge-pull.ts`): header, merge gates, the primary control
/// and what is under it.
struct ForgePullPage: Decodable, Sendable, Equatable {
    struct Gate: Decodable, Sendable, Equatable, Hashable { let label: String; let value: String; let detail: String?; let tone: String }
    struct Action: Decodable, Sendable, Equatable {
        /// `merge`, `enable-auto-merge` or `disable-auto-merge`.
        let kind: String
        let label: String
        let disabled: String?
    }
    struct Method: Decodable, Sendable, Equatable, Hashable { let method: String; let label: String }
    struct Reviewer: Decodable, Sendable, Equatable, Hashable { let login: String; let outcome: String? }
    struct Check: Decodable, Sendable, Equatable, Hashable { let name: String; let tone: String; let word: String }
    struct File: Decodable, Sendable, Equatable, Hashable { let path: String; let additions: Int; let deletions: Int; let status: String }

    let number: Int
    let repository: ForgeRepository
    let title: String
    let url: String
    let state: ForgeMark
    let merged: Bool
    let author: String
    let createdAt: Double?
    let updatedAt: Double?
    let headBranch: String
    let baseBranch: String
    let headSha: String
    let additions: Int?
    let deletions: Int?
    let commits: Int
    let changedFiles: Int
    let body: String
    let bodyBlocks: [ForgeRichBlock]
    let tasks: Bool
    let conversation: String
    let labels: [ForgeLabel]
    let gates: [Gate]
    let primary: String
    let action: Action?
    let secondary: Action?
    let blockers: [String]
    let methods: [Method]
    let method: String
    let reviewers: [Reviewer]
    let checks: [Check]
    let files: [File]
    let threads: [ForgeRelatedThread]
}

/// A pull request write pinned to what the person saw when they asked: the head commit and
/// merge method of that moment. A refresh never retargets it; a different head or method ends it.
struct ForgeWriteTarget: Sendable, Equatable {
    let action: ForgePullPage.Action
    let project: String
    let number: Int
    let repository: ForgeRepository
    let headSha: String
    let method: String
    init(action: ForgePullPage.Action, project: String, page: ForgePullPage, method: String) {
        self.action = action
        self.project = project
        number = page.number
        repository = page.repository
        headSha = page.headSha
        self.method = method
    }
    /// Whether the page still shows what this write was asked against.
    func matches(_ page: ForgePullPage?, method: String) -> Bool {
        page?.number == number && page?.headSha == headSha && method == self.method
    }
    var payload: [String: Any] {
        var payload: [String: Any] = [
            "project": project, "number": number, "repository": repository.json,
            "method": method, "headSha": headSha,
        ]
        switch action.kind {
        case "merge": payload["type"] = "forge.merge"
        case "enable-auto-merge": payload["type"] = "forge.auto-merge"; payload["action"] = "enable"
        default: payload["type"] = "forge.auto-merge"; payload["action"] = "disable"
        }
        return payload
    }
}

struct ForgeRelatedThread: Decodable, Sendable, Equatable, Hashable {
    let id: String
    let title: String
    let archived: Bool
    let needsYou: Bool
}

/// One issue's page (`bridge/forge-issue.ts`), and what a thread started from it opens with.
struct ForgeIssuePage: Decodable, Sendable, Equatable {
    struct Event: Decodable, Sendable, Equatable, Identifiable {
        let id: String
        let comment: Bool
        let actor: String
        let event: String
        let at: Double?
        let body: String?
        let blocks: [ForgeRichBlock]
    }
    struct IssueRef: Codable, Sendable, Equatable, Hashable {
        let repository: ForgeRepository
        let number: Int
        var json: [String: Any] { ["repository": repository.json, "number": number] }
    }
    struct Start: Decodable, Sendable, Equatable { let text: String; let issue: IssueRef }

    let number: Int
    let repository: ForgeRepository
    let title: String
    let url: String
    let state: ForgeMark
    let author: String
    let createdAt: Double?
    let updatedAt: Double?
    let body: String
    let bodyBlocks: [ForgeRichBlock]
    let tasks: Bool
    let labels: [ForgeLabel]
    let assignees: [String]
    let milestone: String?
    let events: [Event]
    let moreEvents: Bool
    let threads: [ForgeRelatedThread]
    let start: Start
}
