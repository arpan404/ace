import Foundation

/// A pull request's management state (`bridge/forge-manage.ts`): milestone, closing issues,
/// head branch, conversation lock, and the writes GitHub hasn't confirmed.
struct ForgeManage: Decodable, Sendable, Equatable {
    struct Milestone: Decodable, Sendable, Equatable, Hashable { let number: Int; let title: String }
    struct Issue: Decodable, Sendable, Equatable { let number: Int; let title: String; let state: ForgeMark; let manual: Bool; let url: String }
    struct Branch: Decodable, Sendable, Equatable { let name: String; let exists: Bool; let delete: Bool; let restore: Bool; let note: String? }
    struct Conversation: Decodable, Sendable, Equatable { let locked: Bool; let reason: String?; let lock: Bool; let unlock: Bool }
    struct Unconfirmed: Decodable, Sendable, Equatable, Hashable { let id: String; let label: String }
    struct Reason: Decodable, Sendable, Equatable, Hashable { let value: String; let label: String }
    struct Revert: Decodable, Sendable, Equatable { let title: String; let body: String }
    /// A state change GitHub allows now (ready, draft, close, reopen, update.merge, update.rebase).
    struct Step: Decodable, Sendable, Equatable, Hashable { let kind: String; let label: String }
    /// The pull request's text and people, as the edit sheet starts from them.
    struct Metadata: Decodable, Sendable, Equatable {
        let title: String
        let body: String
        let baseBranch: String
        let labels: [String]
        let assignees: [String]
    }
    let version: String
    /// open, draft, closed or merged.
    let state: String
    let lifecycle: [Step]
    let metadata: Metadata
    /// Which of `metadata`'s fields this account may change: title, body, baseBranch, labels, assignees.
    let editable: [String]
    let milestone: Milestone?
    let milestones: [Milestone]?
    let closingIssues: [Issue]
    let canLink: Bool
    let branch: Branch?
    let conversation: Conversation?
    let unconfirmed: [Unconfirmed]
    let reasons: [Reason]
    /// The draft that reverts this merged pull request; nil where GitHub offers no revert.
    let revert: Revert?
}

/// Where a new pull request can open (`forge.newpr.context`).
struct ForgeNewPrContext: Decodable, Sendable, Equatable {
    struct Head: Decodable, Sendable, Equatable { let owner: String; let name: String; let branches: [String] }
    let repository: ForgeRepository
    let defaultBranch: String
    let bases: [String]
    let head: Head
    let template: String
    /// "Opens on GitLab · acme/ace", only when the project uses more than one repository.
    var opensOn: String? = nil
    /// What it may be given besides its text; nil when GitHub didn't say.
    var details: Details? = nil

    /// The repository's people, labels and open milestones, and how many of each GitHub takes.
    struct Details: Decodable, Sendable, Equatable {
        struct Label: Decodable, Sendable, Equatable, Hashable { let name: String; let color: String?; let description: String }
        struct Milestone: Decodable, Sendable, Equatable, Hashable { let number: Int; let title: String; let due: String? }
        struct Most: Decodable, Sendable, Equatable { let reviewers: Int; let assignees: Int; let labels: Int }
        /// People GitHub lets be assigned; the same people can be asked to review.
        let people: [String]
        let labels: [Label]
        let milestones: [Milestone]
        let most: Most
    }
}

/// What a new pull request is given besides its text, as the person picked it.
struct ForgeNewPrDetailsDraft: Equatable {
    var reviewers: [String] = []
    var assignees: [String] = []
    var labels: [String] = []
    var milestone: Int?
    var json: [String: Any] {
        var json: [String: Any] = ["reviewers": reviewers, "assignees": assignees, "labels": labels]
        if let milestone { json["milestone"] = milestone }
        return json
    }
}

/// What a pull request of two branches would hold (`forge.newpr.compare`).
struct ForgeNewPrCompare: Decodable, Sendable, Equatable {
    struct Commit: Decodable, Sendable, Equatable, Hashable { let sha: String; let title: String }
    let summary: String
    let blocked: String?
    let existing: Int?
    let commits: [Commit]
}

/// A create's outcome: the pull request opened (or the one the branches already had).
struct ForgeNewPrCreated: Decodable, Sendable, Equatable {
    let ok: Bool
    let message: String
    let uncertain: Bool
    let number: Int?
}

extension ClientModel {
    static func forgeManageRead(project: String, number: Int, repository: ForgeRepository? = nil) -> [String: Any] {
        on(repository, ["type": "forge.pull.manage", "project": project, "number": number])
    }
    func forgeManage(project: String, number: Int, repository: ForgeRepository? = nil) async throws -> ForgeManage {
        try await read(Self.forgeManageRead(project: project, number: number, repository: repository), as: ForgeManage.self)
    }
    /// One lifecycle write pinned to `version`, or a reconcile of one GitHub hasn't confirmed.
    func forgeManageWrite(_ target: ForgePullTarget, operation: [String: Any]) async -> ForgeReviewOutcome {
        guard canOperate else { return ForgeReviewOutcome(ok: false, message: "View only. Pair this phone with View and act to change pull requests.", uncertain: false) }
        let request: [String: Any] = ["type": "forge.manage", "project": target.project, "number": target.number,
                                      "repository": target.repository.json, "operation": operation]
        do { return try await service(request, as: ForgeReviewOutcome.self) }
        catch { return ForgeReviewOutcome(ok: false, message: error.localizedDescription, uncertain: false) }
    }
    func forgeNewPrContext(project: String) async throws -> ForgeNewPrContext {
        try await read(["type": "forge.newpr.context", "project": project], as: ForgeNewPrContext.self)
    }
    func forgeNewPrCompare(project: String, repository: ForgeRepository, base: String, head: [String: Any]) async throws -> ForgeNewPrCompare {
        try await read(["type": "forge.newpr.compare", "project": project, "repository": repository.json, "base": base, "head": head], as: ForgeNewPrCompare.self)
    }
    func forgeNewPrCreate(project: String, repository: ForgeRepository, base: String, head: [String: Any], title: String, body: String, draft: Bool,
                          details: ForgeNewPrDetailsDraft = ForgeNewPrDetailsDraft()) async -> ForgeNewPrCreated {
        guard canOperate else { return ForgeNewPrCreated(ok: false, message: "View only. Open pull requests on your computer, or pair this phone with View and act.", uncertain: false, number: nil) }
        let request = details.json.merging(["type": "forge.newpr.create", "project": project, "repository": repository.json, "base": base,
                                            "head": head, "title": title, "body": body, "draft": draft]) { _, own in own }
        do { return try await service(request, as: ForgeNewPrCreated.self) }
        catch { return ForgeNewPrCreated(ok: false, message: error.localizedDescription, uncertain: false, number: nil) }
    }
}

extension ClientModel {
    /// Comment on an issue, sent once with its own command id.
    func forgeIssueComment(project: String, repository: ForgeRepository, number: Int, body: String) async -> ForgeReviewOutcome {
        guard canOperate else { return ForgeReviewOutcome(ok: false, message: "View only. Pair this phone with View and act to comment.", uncertain: false) }
        let request: [String: Any] = ["type": "forge.issue.comment", "project": project, "repository": repository.json, "number": number, "body": body]
        do { return try await service(request, as: ForgeReviewOutcome.self) }
        catch { return ForgeReviewOutcome(ok: false, message: error.localizedDescription, uncertain: false) }
    }
    /// Ask GitHub what became of an issue write whose answer never came.
    func forgeIssueCheck(project: String, repository: ForgeRepository, actionId: String) async -> ForgeReviewOutcome {
        let request: [String: Any] = ["type": "forge.issue.check", "project": project, "repository": repository.json, "actionId": actionId]
        do { return try await service(request, as: ForgeReviewOutcome.self) }
        catch { return ForgeReviewOutcome(ok: false, message: error.localizedDescription, uncertain: false) }
    }
}
