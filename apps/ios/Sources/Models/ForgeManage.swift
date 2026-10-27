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
    let version: String
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
    func forgeNewPrCreate(project: String, repository: ForgeRepository, base: String, head: [String: Any], title: String, body: String, draft: Bool) async -> ForgeNewPrCreated {
        guard canOperate else { return ForgeNewPrCreated(ok: false, message: "View only. Open pull requests on your computer, or pair this phone with View and act.", uncertain: false, number: nil) }
        let request: [String: Any] = ["type": "forge.newpr.create", "project": project, "repository": repository.json, "base": base,
                                      "head": head, "title": title, "body": body, "draft": draft]
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
