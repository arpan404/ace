import Foundation

/// A step's one line, worded by the shared work-log rules in the bridge.
struct StepLine: Codable, Sendable, Equatable {
    let icon: String
    let verb: String
    let target: String
    let note: String
    let settled: Bool
    let failed: Bool
    let needsYou: Bool
    let added: Int?
    let removed: Int?
}
struct AttachmentLine: Codable, Sendable, Equatable, Hashable {
    let kind: String
    let name: String
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
        }
        let status: String
        let entries: [Entry]
    }
    struct Ending: Codable, Sendable, Equatable {
        let label: String
        let automatic: Bool
        let error: String
    }
    struct Started: Codable, Sendable, Equatable {
        let threadId: String
        let title: String
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
}

/// The composer's canonical choices: delivery while busy, the alternate, and Stop.
struct ControlsRow: Codable, Sendable, Equatable {
    let busy: Bool
    let delivery: String?
    let alternate: String?
    let canStop: Bool
    let provider: String
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
