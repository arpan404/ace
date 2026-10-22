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
    let labels: [ForgeLabel]
    let assignees: [String]
    let milestone: String?
    let events: [Event]
    let moreEvents: Bool
    let threads: [ForgeRelatedThread]
    let start: Start
}
