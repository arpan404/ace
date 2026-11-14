import Foundation

/// A new thread's worktree as it is made (`bridge/worktree-starts.ts`, the web's
/// `WorktreeCreationCard`): worded by the bridge; Swift draws it and sends the actions back.
struct WorktreeStartCard: Codable, Sendable, Equatable {
    struct Step: Codable, Sendable, Equatable {
        let label: String
        /// "done", "running", "failed" or "stopped".
        let state: String
        let elapsedMs: Double
        /// Checkout's share of files written, while it runs.
        let percent: Int?
    }
    struct Action: Codable, Sendable, Equatable, Identifiable {
        /// "local", "cancel", "retry" or "continue".
        let id: String
        /// "Cancel", or "Cancelling…" while it is on its way.
        let label: String
    }
    let headline: String
    let running: Bool
    let failed: Bool
    let steps: [Step]
    /// Why it stopped, in the daemon's fixed words; empty while it runs.
    let note: String
    /// Why the last action didn't happen; empty when it did.
    let refused: String
    /// A stale Git lock stopped it: clearing it happens on the computer.
    let locked: Bool
    let actions: [Action]
    /// The action on its way, or empty.
    let sending: String
    /// The daemon's redacted log, newest last.
    let details: [String]
    /// The words the person sent and the project it starts in, for Back to New thread.
    var message: String? = nil
    var workspaceId: String? = nil
    /// It stopped with nothing on its way: Back to New thread is offered. Nil from older bridges.
    var canReturn: Bool? = nil

    /// New thread's draft when the person takes a stopped start back: its words, on its machine
    /// and project, in a worktree again. A fresh command id is made when it is sent.
    func returnedDraft(machineId: String) -> NewThreadDraft {
        var draft = NewThreadDraft()
        draft.machineId = machineId
        draft.projectId = workspaceId
        draft.worktree = true
        draft.text = message ?? ""
        return draft
    }
}

/// One start's report: its card, and the thread made (in the worktree or on the local checkout).
struct WorktreeStartRead: Sendable, Equatable {
    var card: WorktreeStartCard?
    var made: String? = nil
}

/// What New thread does next while a start it sent is pending.
enum NewThreadWait: Equatable {
    case wait
    case open(String)
    case refused(String)

    /// `outcome` is the daemon's receipt, `worktree` the worktree's report, `listed` whether the
    /// thread list already has a thread (it opens once it does).
    static func next(outcome: ComposeOutcome?, worktree: WorktreeStartRead?, listed: (String) -> Bool) -> NewThreadWait {
        let thread = outcome?.ok == true ? outcome?.id : worktree?.made
        if let thread { return listed(thread) ? .open(thread) : .wait }
        guard let outcome, !outcome.ok else { return .wait }
        // A cancel or a failed setup keeps its card, with Retry and Don't use worktree.
        if worktree?.card != nil { return .wait }
        return .refused(outcome.message.isEmpty ? "The thread didn't start." : outcome.message)
    }
}
