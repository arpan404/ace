import Foundation

/// What a message's action row offers beyond Copy, by the bridge's shared rules
/// (`bridge/message-actions.ts`): Fork from an answer whose turn ended, Edit on the person's
/// message with a finished answer before it, Rewind on Pi's own answers.
struct MessageActionsLine: Codable, Sendable, Equatable {
    let fork: Bool
    let edit: Bool
    let rewind: Bool
}

/// The open thread's transitions (`thread.transitions`).
struct TransitionsRow: Codable, Sendable, Equatable {
    struct Retry: Codable, Sendable, Equatable { let answerId: String; let askId: String }
    struct Parent: Codable, Sendable, Equatable { let threadId: String; let ready: Bool }
    /// A Pi thread: answers can be rewound to and retried in place.
    let pi: Bool
    /// Every agent finished: Pi can go back now.
    let settled: Bool
    /// The answer Retry sits under; nil where nothing retries.
    let retry: Retry?
    /// "Fork from the last turn" has a turn to start from.
    let lastTurn: Bool
    /// The thread this fork brings its work back to; nil for a thread that isn't a fork.
    let parent: Parent?
}

/// A fork the composer writes (`thread.fork`): where it starts, the words it starts with, and the
/// model picked for it (empty: what the thread runs).
struct ForkDraftRow: Codable, Sendable, Equatable {
    /// Where the composer keeps the fork's words, apart from the thread's own message.
    let key: String
    /// "“Here is the plan.”", "the last turn", "before “Use the other approach”".
    let from: String
    let prefill: String
    let sending: Bool
    let model: String
    let provider: String
}

/// Bring back to parent's summary as it starts out: the fork's newest own answer.
struct MergeDraftRow: Codable, Sendable, Equatable {
    let ready: Bool
    /// Why it can't go yet (`bringBackOf` in `@ace/ui-core`); empty once it can.
    var waits: String? = nil
    let summary: String
}

/// Where a fork starts, as the bridge's `fork.open` names it.
enum ForkStart: Equatable {
    case answer(itemId: String, runId: String?)
    case latest
    case edit(itemId: String)
    var payload: [String: Any] {
        switch self {
        case .answer(let itemId, let runId):
            var at: [String: Any] = ["kind": "answer", "itemId": itemId]
            if let runId { at["runId"] = runId }
            return at
        case .latest: return ["kind": "latest"]
        case .edit(let itemId): return ["kind": "edit", "itemId": itemId]
        }
    }
}
