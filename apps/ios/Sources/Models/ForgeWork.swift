import Foundation

/// A pull request's checks (`bridge/forge-checks.ts`): GitHub's, and the project's local check.
struct ForgeChecks: Decodable, Sendable, Equatable {
    struct Row: Decodable, Sendable, Equatable, Hashable { let id: String; let name: String; let word: String; let tone: String; let opens: Bool; let url: String? }
    struct Control: Decodable, Sendable, Equatable { let kind: String; let label: String; let disabled: Bool }
    struct Local: Decodable, Sendable, Equatable { let name: String; let word: String; let tone: String; let runId: String?; let action: Control?; let note: String? }
    let headSha: String
    let checks: [Row]
    let local: Local?
    let stale: Bool
}

/// One check as its page shows it: state, what its app said, annotations, steps and its log.
struct ForgeCheckPage: Decodable, Sendable, Equatable {
    struct Output: Decodable, Sendable, Equatable { let title: String?; let summary: String?; let text: String? }
    struct Annotation: Decodable, Sendable, Equatable, Hashable { let `where`: String?; let level: String; let tone: String; let title: String?; let message: String }
    struct Step: Decodable, Sendable, Equatable, Hashable { let name: String; let word: String; let tone: String; let line: Int? }
    struct Log: Decodable, Sendable, Equatable { let lines: Int; let truncated: Bool; let focus: Int?; let errors: [Int] }
    struct Workflow: Decodable, Sendable, Equatable { let runId: Int; let attempt: Int }
    struct Controls: Decodable, Sendable, Equatable { let rerunFailed: Bool; let rerunAll: Bool; let cancel: Bool; let fix: Bool }
    struct Fix: Decodable, Sendable, Equatable {
        struct Pull: Decodable, Sendable, Equatable { let repository: ForgeRepository; let number: Int; let headSha: String; let title: String }
        let request: String
        let threadId: String?
        /// With no linked thread, the pull request a new thread starts on.
        let pullRequest: Pull?
    }
    let name: String
    let word: String
    let tone: String
    let url: String?
    let checkRunId: Int?
    let jobId: Int?
    let finished: Bool
    let output: Output
    let annotations: [Annotation]
    let annotationsMore: Bool
    let steps: [Step]
    let log: Log?
    let note: String?
    let workflow: Workflow?
    let controls: Controls
    let fix: Fix?
}

/// Lines `from ..< from + lines.count` of a log of `total` lines.
struct ForgeLogPage: Decodable, Sendable, Equatable { let from: Int; let lines: [String]; let total: Int }

/// A pull request's merge conflicts in a linked thread's checkout.
struct ForgeConflicts: Decodable, Sendable, Equatable {
    struct Hunk: Decodable, Sendable, Equatable, Hashable { let ours: String; let theirs: String; let base: String?; let draft: String }
    struct File: Decodable, Sendable, Equatable, Hashable { let path: String; let unavailable: String?; let revision: String?; let hunks: [Hunk]; let request: String }
    struct Checkout: Decodable, Sendable, Equatable { let head: String?; let merging: Bool; let dirty: Bool; let files: [File]; let truncated: Bool }
    let threads: [ForgeThreadChoice]
    let threadId: String?
    let baseBranch: String
    let headBranch: String
    let checkout: Checkout?
    let note: String?
}

struct ForgeThreadChoice: Decodable, Sendable, Equatable, Hashable { let id: String; let title: String }

/// A pull request's stack: layers in order, the operation in flight, and its controls.
struct ForgeStackPage: Decodable, Sendable, Equatable {
    struct Signal: Decodable, Sendable, Equatable, Hashable { let label: String; let tone: String }
    struct Merge: Decodable, Sendable, Equatable, Hashable { let label: String; let blocked: Bool }
    struct Layer: Decodable, Sendable, Equatable, Hashable {
        let number: Int; let title: String; let branch: String; let state: String
        let checks: Signal; let review: Signal; let merge: Merge; let current: Bool
    }
    struct Stack: Decodable, Sendable, Equatable { let number: Int; let trunk: String; let layers: [Layer] }
    struct Confirm: Decodable, Sendable, Equatable, Hashable { let text: String; let lines: [String]; let button: String; let ready: Bool; let review: String }
    struct Control: Decodable, Sendable, Equatable, Hashable, Identifiable {
        let action: String; let label: String; let reason: String?; let confirm: Confirm?
        var id: String { action }
        /// Undoing local work: shown red and asked first.
        var destructive: Bool { action == "abort" }
    }
    let threads: [ForgeThreadChoice]
    let threadId: String?
    let stack: Stack?
    let operation: Signal?
    let moved: [String]
    let note: String?
    let controls: [Control]
}

/// The threads working on a pull request, and whether each one's checkout holds its head.
struct ForgeWorkPage: Decodable, Sendable, Equatable {
    struct Thread: Decodable, Sendable, Equatable, Hashable { let id: String; let title: String; let checkout: String?; let branch: String? }
    let headSha: String
    let open: Bool
    let blocked: String?
    let threads: [Thread]
}

/// A write's outcome; a revert also names the pull request it opened.
struct ForgeWorkOutcome: Decodable, Sendable, Equatable {
    let ok: Bool
    let message: String
    let uncertain: Bool
    var opened: Int?
}

extension ClientModel {
    static func forgeChecksRead(_ route: ForgeRoute) -> [String: Any] {
        on(route.repository, ["type": "forge.pull.checks", "project": route.project, "number": route.number])
    }
    static func forgeCheckRead(_ route: ForgeRoute, checkId: String) -> [String: Any] {
        on(route.repository, ["type": "forge.pull.check", "project": route.project, "number": route.number, "checkId": checkId])
    }
    static func forgeConflictsRead(_ route: ForgeRoute, threadId: String?) -> [String: Any] {
        var read = on(route.repository, ["type": "forge.pull.conflicts", "project": route.project, "number": route.number])
        if let threadId { read["threadId"] = threadId }
        return read
    }
    static func forgeStackRead(_ route: ForgeRoute, threadId: String?, method: String) -> [String: Any] {
        var read = on(route.repository, ["type": "forge.pull.stack", "project": route.project, "number": route.number, "method": method])
        if let threadId { read["threadId"] = threadId }
        return read
    }
    static func forgeWorkRead(_ route: ForgeRoute) -> [String: Any] {
        on(route.repository, ["type": "forge.pull.work", "project": route.project, "number": route.number])
    }

    /// A page's read; `fresh` asks GitHub again rather than the bridge's memory.
    func forgeWorkRead<T: Decodable>(_ payload: [String: Any], fresh: Bool = false, as type: T.Type) async throws -> T {
        var request = payload
        if fresh { request["fresh"] = true }
        return try await read(request, as: type)
    }
    /// One log page; never kept, so a long log costs only what is drawn.
    func forgeLog(_ payload: [String: Any]) async throws -> ForgeLogPage {
        try await service(payload, as: ForgeLogPage.self)
    }
    /// One write from a PR page, sent once. A view-only grant says so instead of sending.
    func forgeWorkWrite(_ payload: [String: Any]) async -> ForgeWorkOutcome {
        guard canOperate else { return ForgeWorkOutcome(ok: false, message: "View only. Pair this phone with View and act to change pull requests.", uncertain: false) }
        do { return try await service(payload, as: ForgeWorkOutcome.self, timeout: .seconds(120)) }
        catch { return ForgeWorkOutcome(ok: false, message: error.localizedDescription, uncertain: true) }
    }
}
