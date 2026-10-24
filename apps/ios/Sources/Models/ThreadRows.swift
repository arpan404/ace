import Foundation

/// A step's one line, worded by the shared work-log rules in the bridge.
struct StepLine: Codable, Sendable, Equatable {
    let icon: String
    /// What the row's glyph shows (`@ace/ui-core` `stepGlyphKind`).
    var glyph: String? = nil
    let verb: String
    let target: String
    let note: String
    let settled: Bool
    let failed: Bool
    let needsYou: Bool
    let added: Int?
    let removed: Int?
    /// An agent opened a page in the thread's browser; the row opens it.
    var browser: Bool? = nil
    /// `device:<id>` or `computer`: where tapping the step goes; empty or nil for nowhere.
    var opens: String? = nil
    /// Waits on an approval nobody has answered: the row steps aside for the composer's request.
    var awaiting: Bool? = nil
    /// The row opens to its output, diff or reasoning.
    var expandable: Bool? = nil
    /// What the opened row shows, bounded by the bridge.
    var detail: StepDetail? = nil
}
/// An opened step: a command's output tail, compact diffs, a search's matches, a failure.
struct StepDetail: Codable, Sendable, Equatable {
    struct Diff: Codable, Sendable, Equatable {
        struct Line: Codable, Sendable, Equatable {
            /// `add`, `del`, `context` or `hunk`.
            let kind: String
            let text: String
        }
        let path: String
        /// `create`, `delete`, `move`; empty for an update.
        let kind: String
        let lines: [Line]
        let more: Int
    }
    let output: String
    let outputTruncated: Bool
    let text: String
    let diffs: [Diff]
}
/// One image or file of a message (`bridge/thread-rows.ts`). `ref` names it to
/// `native.attachment`; `thumbnail` says a preview can be read, `opens` that the file can.
/// The newer fields are optional so a row kept by an older build still decodes.
struct AttachmentLine: Codable, Sendable, Equatable, Hashable {
    let kind: String
    let name: String
    var ref: String? = nil
    var mimeType: String? = nil
    var bytes: Int? = nil
    var width: Double? = nil
    var height: Double? = nil
    var thumbnail: Bool? = nil
    var opens: Bool? = nil
}

/// One transcript block as `@ace/ui-core` groups it. Items are referenced by id; their rows
/// stream separately, so a delta never rebuilds a block.
struct BlockRow: Codable, Sendable, Equatable {
    struct Work: Codable, Sendable, Equatable {
        let label: String
        let counts: String
        let current: String
        let ongoing: Bool
        let outcome: String
        let startedAt: Double
        let failed: Int
    }
    struct Agents: Codable, Sendable, Equatable {
        struct Entry: Codable, Sendable, Equatable, Identifiable {
            let id: String
            let agentId: String
            let threadId: String
            let title: String
            let state: String
            let label: String
            /// The shared status palette key that colours this branch's state.
            let token: String
            let provider: String
            let model: String
            let result: String
            /// "Opus 4.7 · High", "Delegated · GPT-5.5"; empty when none is known.
            var meta: String = ""
            /// The paired machine it runs on, when that is another one.
            var machine: String = ""
            /// Its second line: what it does now, waits on, failed with or found.
            var detail: String = ""
            /// "live", "result", "human", "failed" or empty.
            var detailKind: String = ""
            /// Ticks from here while it runs and the facts are fresh (ms since 1970).
            var since: Double? = nil
            /// How long it ran, once settled; empty when not shown.
            var elapsed: String = ""
        }
        /// One part of the status line, in its status colour: "2 working".
        struct Count: Codable, Sendable, Equatable { let text: String; let token: String }
        /// The group's lead: each provider once, at most three, past three two and "+N".
        struct Lead: Codable, Sendable, Equatable {
            let providers: [String]
            let more: Int
            let label: String
        }
        let status: String
        let entries: [Entry]
        var counts: [Count]? = nil
        /// "3 subagents".
        var title: String = ""
        /// The group's worst child, as a status palette key.
        var token: String = ""
        /// Its facts are stale while it ran: "Last seen: " leads the counts.
        var stale: Bool = false
        var lead: Lead? = nil
        var since: Double? = nil
        var elapsed: String = ""
    }
    /// A question where the agent asked it: "Codex is asking · title" while it waits.
    struct Question: Codable, Sendable, Equatable {
        let asking: Bool
        let asker: String
        let title: String
        let answer: String
        let outcome: String
    }
    struct Started: Codable, Sendable, Equatable {
        let threadId: String
        let title: String
        /// "New thread" or "Fork".
        var label: String = ""
        var provider: String = ""
        var model: String = ""
    }
    let index: Int?
    let kind: String
    let items: [String]
    let headed: Bool
    let interactionId: String
    let work: Work?
    let agents: Agents?
    let ending: Ending?
    let started: Started?
    var question: Question? = nil
    /// The room it asks for above and below itself: 8, 16 or 24 (`@ace/ui-core` row-room).
    var room: Room? = nil
    struct Room: Codable, Sendable, Equatable { let before: Double; let after: Double }
    /// A settled work head's root turn, whose full steps open on demand.
    var ordinal: Int? = nil
    /// The work log's rows, as the web groups them (`bridge/work-log.ts`).
    var log: [LogRow]? = nil
    /// ace's own steps, worded with what earlier steps of the log said about them.
    var aceSteps: [AceStep]? = nil
    /// Failed steps a later step ran again with success.
    var retried: [String]? = nil
    var thoughts: [Thought]? = nil
    var files: Files? = nil
    /// The log's calls that left a command running in the background (`bridge/background-rows.ts`).
    var background: [Background]? = nil
    /// An answer block: its text still arrives while its turn runs.
    var streaming: Bool? = nil
    /// An event block's one row as the web decides it (`@ace/ui-core` `eventView`); nil for the
    /// person's own bubble.
    var event: EventRow? = nil
    struct Background: Codable, Sendable, Equatable {
        let itemId: String
        let taskId: String
        /// "Running in background", "Finished", "Stopped".
        let label: String
        let command: String
        let running: Bool
        var status: String? = nil
        let stoppable: Bool
        /// Ms since 1970.
        let startedAt: Double
        let endedAt: Double?
    }
}

/// Something that happened to the thread rather than in the conversation, flattened by the bridge
/// (`bridge/thread-messages.ts`). `kind` picks the row: "event" and "system" (a muted row with its
/// time, opening `note` and `detail`), "error", "refusal", "notSent", "notice", "quiet",
/// "handoff", "user", "none"; others draw the item as it is.
struct EventRow: Codable, Sendable, Equatable {
    let kind: String
    let icon: String
    let provider: String
    let text: String
    let note: String
    let detail: String
    /// The detail is what the model was sent: monospaced.
    let mono: Bool
    /// Ms since 1970; 0 when the row shows no time.
    let at: Double
    /// How many identical rows this one stands for.
    let count: Int
}

/// The composer's canonical choices: delivery while busy, the alternate, and Stop.
struct ControlsRow: Codable, Sendable, Equatable {
    let busy: Bool
    let delivery: String?
    let alternate: String?
    let canStop: Bool
    let provider: String
    /// The provider's display name, for the model sheet's header.
    var providerName: String?
    let model: String
    let switching: String
}
/// The daemon queue's follow-ups for the open thread, with the shared summary line.
struct QueueRow: Codable, Sendable, Equatable {
    struct Message: Codable, Sendable, Equatable, Identifiable {
        let id: String
        let text: String
        let delivery: String
        let state: String
        let attachments: Int
    }
    let revision: Int
    let label: String
    let when: String
    let messages: [Message]
    let more: Int
}
struct ModelOption: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let label: String
    let detail: String
    let current: Bool
}

extension ApprovalRow {
    /// One of the three verbs, naming an offered option by its index in `options`.
    struct Decision: Codable, Sendable, Equatable {
        let verb: String
        let option: Int
        let label: String
        let scope: String
        let emphasis: String
    }
    struct Other: Codable, Sendable, Equatable {
        let option: Int
        let label: String
    }
    struct Question: Codable, Sendable, Equatable, Identifiable {
        struct Choice: Codable, Sendable, Equatable, Identifiable {
            let id: String
            let label: String
            let detail: String
            let recommended: Bool
        }
        let id: String
        let header: String
        let text: String
        let multiSelect: Bool
        let allowOther: Bool
        let options: [Choice]
    }
    struct Verb: Identifiable {
        let decision: Decision
        let option: Option
        var id: String { option.id }
    }
    struct Remaining: Identifiable {
        let label: String
        let option: Option
        var id: String { option.id }
    }
    /// The verbs in card order (Deny, Always, Allow), each with its exact canonical option.
    var verbs: [Verb] {
        let order = ["deny": 0, "always_allow": 1, "allow_once": 2]
        return (decisions ?? []).compactMap { decision in
            options.indices.contains(decision.option) ? Verb(decision: decision, option: options[decision.option]) : nil
        }.sorted { (order[$0.decision.verb] ?? 3) < (order[$1.decision.verb] ?? 3) }
    }
    /// Every offered option outside the verbs, with its own words.
    var remaining: [Remaining] {
        guard let decisions else { return [] }
        let labels = Dictionary((others ?? []).map { ($0.option, $0.label) }, uniquingKeysWith: { first, _ in first })
        let taken = Set(decisions.map(\.option))
        return options.indices.filter { !taken.contains($0) }.map { Remaining(label: labels[$0] ?? options[$0].label, option: options[$0]) }
    }
}
