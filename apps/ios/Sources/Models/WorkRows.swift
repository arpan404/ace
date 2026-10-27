import Foundation

/// A way out of a checkout problem, as the bridge words it (`bridge/work.ts`). A destructive one
/// asks before it runs.
struct WorkAction: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let label: String
    let destructive: Bool
}

/// The thread's Work sheet: where its checkout lives and what can move it. Every decision
/// (whether it may move, what stops it, how a PR reads) is `@ace/ui-core`'s; Swift draws it.
struct WorkSummary: Codable, Sendable, Equatable {
    struct PullRequest: Codable, Sendable, Equatable, Identifiable {
        let id: String
        let number: Int
        let title: String
        /// `open`, `draft`, `merged` or `closed`.
        let state: String
        /// "open · couldn't verify with GitHub".
        let summary: String
        /// The last state may be out of date.
        let stale: Bool
        let url: String
        /// "owner/name".
        let repo: String
        let owner: String
        let name: String
    }
    struct Problem: Codable, Sendable, Equatable {
        let kind: String
        let label: String
        let detail: String
        let failed: Bool
        /// A failed setup script's last lines.
        let output: [String]
        let actions: [WorkAction]
    }
    /// `loading`, `ready`, `none` (not a git checkout) or `error` (with `error` in words).
    let state: String
    let error: String
    /// A chat's folder has no branch or pull requests.
    let chat: Bool
    let project: String
    let machine: String
    let path: String
    /// `local` or `worktree`; nil until the checkout is read.
    let mode: String?
    let branch: String
    let baseBranch: String
    /// "2 commits not pushed".
    let note: String
    /// Why the branch can't switch (or the checkout go back to local) now.
    let switchReason: String?
    /// Why the checkout can't move into a worktree now.
    let worktreeReason: String?
    let prs: [PullRequest]
    let morePrs: Int
    let problem: Problem?
    /// An earlier ace daemon's Git lock fences the checkout.
    let locked: Bool
    /// A change to the checkout is running.
    let busy: Bool
}

/// The project's branches for the picker, default first, read when the picker opens.
struct WorkBranches: Codable, Sendable, Equatable {
    /// `loading`, `ready` or `error`.
    let state: String
    let names: [String]
    let truncated: Bool
}

/// A Work write's outcome, correlated by request id. `ask` comes back when uncommitted changes
/// stopped a move: the person decides, and only then is it sent again.
struct WorkResult: Codable, Sendable, Equatable {
    struct Ask: Codable, Sendable, Equatable { let title: String; let detail: String; let confirm: String }
    let id: String
    let ok: Bool
    let message: String
    /// Sent, but no answer came: it may have gone through.
    let uncertain: Bool
    let ask: Ask?
}

/// What stops the open thread's checkout, as the line above the composer (`bridge/work-line.ts`).
struct WorkLine: Codable, Sendable, Equatable {
    let kind: String
    let label: String
    let detail: String
    let actions: [WorkAction]
}
