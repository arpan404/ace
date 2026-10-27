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
    /// Where a fork's own work starts: the thread it was forked from.
    struct Forked: Codable, Sendable, Equatable { let threadId: String }
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
    var forked: Forked? = nil
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
    /// A stale Git lock an earlier daemon left stopped this send: Clear stale lock is offered.
    var fenced: Bool? = nil
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
    /// Why the model named isn't running yet: "Applies at the agent's next turn".
    var note: String? = nil
    /// The next message starts a new thread on that model.
    var continues: Bool? = nil
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
/// The open thread's model sheet (`thread.models`, `bridge/thread-model-sheet.ts`): every
/// set-up account's models as New thread lists them, the model checked, and what picking a row
/// does. A row missing from `moves` switches at once; one with a note can't be picked; one with an
/// ask is confirmed first in the words of `asks`. Decoded leniently: a part that doesn't read is
/// left empty rather than failing the frame.
struct ThreadModels: Decodable, Sendable, Equatable {
    struct Move: Decodable, Sendable, Equatable { var ask: Int?; var note: String? }
    /// The shared `switchQuestion`: a switch names the model (`detail`), a continuation may warn
    /// about files the new thread's model can't read.
    struct Ask: Decodable, Sendable, Equatable {
        let title: String; let message: String; let action: String
        var detail: String?; var warning: String?
        /// The alert's body: the message, then the model or the warning.
        var body: String { [message, detail, warning].compactMap { $0 }.joined(separator: "\n\n") }
    }
    var read = ComposeAgentsRead()
    var current: NewThreadPickerRows.Chosen?
    /// The checked model's name when the catalog doesn't list it.
    var currentLabel = ""
    var moves: [String: Move] = [:]
    var asks: [Ask?] = []
    var state: String { read.state }

    init() {}
    private enum Keys: String, CodingKey { case state, tabs, providers, favorites, starProblem, current, currentLabel, rows, asks }
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        read = ComposeAgentsRead(
            state: try box.decode(String.self, forKey: .state),
            agents: (try? box.decodeIfPresent(Lenient<ComposeAgent>.self, forKey: .providers))?.items ?? [],
            tabs: (try? box.decodeIfPresent(Lenient<ComposeTab>.self, forKey: .tabs))?.items ?? [],
            favorites: (try? box.decodeIfPresent([String].self, forKey: .favorites)) ?? [],
            starProblem: try? box.decodeIfPresent(String.self, forKey: .starProblem))
        current = try? box.decodeIfPresent(NewThreadPickerRows.Chosen.self, forKey: .current)
        currentLabel = (try? box.decodeIfPresent(String.self, forKey: .currentLabel)) ?? ""
        moves = (try? box.decodeIfPresent([String: Lenient<Move>.One].self, forKey: .rows))?.compactMapValues(\.value) ?? [:]
        // Positions matter (rows name an ask by index): one that doesn't read stays as a gap.
        asks = (try? box.decodeIfPresent(Lenient<Ask>.Kept.self, forKey: .asks))?.items ?? []
    }
    /// What confirms a move to `row` (a picker row id), if it asks.
    func ask(_ row: String) -> Ask? {
        guard let index = moves[row]?.ask, asks.indices.contains(index) else { return nil }
        return asks[index]
    }
}

/// A list decoded element by element: one entry that doesn't read is dropped (`items`), or kept
/// as a gap where positions matter (`Kept`), so it never empties the rest.
struct Lenient<Element: Decodable>: Decodable {
    let items: [Element]
    init(from decoder: any Decoder) throws {
        var box = try decoder.unkeyedContainer()
        var items: [Element] = []
        while !box.isAtEnd { if let item = try box.decode(One.self).value { items.append(item) } }
        self.items = items
    }
    struct Kept: Decodable {
        let items: [Element?]
        init(from decoder: any Decoder) throws {
            var box = try decoder.unkeyedContainer()
            var items: [Element?] = []
            while !box.isAtEnd { items.append(try box.decode(One.self).value) }
            self.items = items
        }
    }
    /// One value that may not read; decoding it always moves past it.
    struct One: Decodable {
        let value: Element?
        init(from decoder: any Decoder) throws { value = try? Element(from: decoder) }
    }
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
