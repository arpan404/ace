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
    struct MergeCommit: Decodable, Sendable, Equatable, Hashable { var title: String; var message: String }
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
    /// Nil where the host can't say: never shown as a number.
    let commits: Int?
    let changedFiles: Int?
    /// A review ace only reads (not GitHub): the page shows it and offers no writes.
    let hosted: ForgeHostedReview?
    let capabilities: [String]?
    func can(_ capability: String) -> Bool { capabilities?.contains(capability) == true }
    /// The description as shown, drawn by markit; task boxes are named by offsets into it.
    let body: String
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
    /// The commit a merge or squash writes, as GitHub would prefill it; nil for rebase.
    let commit: MergeCommit?
    let reviewers: [Reviewer]
    let checks: [Check]
    let files: [File]
    let threads: [ForgeRelatedThread]
}

/// What a read-only review's page says and links (`bridge/forge-hosted.ts`).
struct ForgeHostedReview: Decodable, Sendable, Equatable {
    /// The provider's name: "GitLab", "Cursor Origin".
    let provider: String
    /// "merge request" on GitLab, "pull request" elsewhere.
    let noun: String
    /// The one sentence under the header.
    let line: String
    /// Said in place of the files when the host doesn't share them.
    let filesUnavailable: String?
    let links: ForgeHostedLinks
}

/// Where references in a read-only review's text open: address templates filled with
/// `{number}`, `{sha}` or `{login}`; nil leaves that kind inert. `review` opens `#N` as that
/// review's page in ace.
struct ForgeHostedLinks: Decodable, Sendable, Equatable, Hashable {
    let issue: String?
    let review: Bool
    let commit: String?
    let mention: String?
}

/// One page of a read-only review's changed files (`forge.pull.hosted-files`).
struct ForgeHostedFiles: Decodable, Sendable, Equatable {
    struct File: Decodable, Sendable, Equatable, Hashable { let path: String; let status: String; let additions: Int; let deletions: Int }
    let headSha: String
    let page: Int
    /// The branch moved since the page was read: this is page 1 of its new changes.
    let moved: Bool
    let files: [File]
    let nextPage: Int?
    let truncated: String?
    let unavailable: String?
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
    /// The commit as the person edited it; GitHub's own when nil.
    var commit: ForgePullPage.MergeCommit?
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
        if let commit { payload["commit"] = ["title": commit.title, "message": commit.message] }
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
    /// GitHub's own updatedAt, which an edit or a state change names; nil from an older bridge.
    let revision: String?
    /// The body as shown, drawn by markit; task boxes are named by offsets into it.
    let body: String
    let tasks: Bool
    let labels: [ForgeLabel]
    let assignees: [String]
    let milestone: String?
    let events: [Event]
    let moreEvents: Bool
    let threads: [ForgeRelatedThread]
    let writable: Bool?
    let box: ForgeBox
    let unconfirmed: [ForgeManage.Unconfirmed]
    let start: Start
}
