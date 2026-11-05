/// What the composer capsule's one trailing button is right now: the microphone while there is
/// nothing to send or stop, Send once there are words or chips, Stop while the tree works and the
/// field is empty. A typed message while the tree works is still Send: it steers or queues.
enum ComposerTrailing: Equatable {
    case dictate
    /// Dictation is running: the button ends it.
    case listening
    case send
    case stop

    static func of(hasContent: Bool, busy: Bool, canStop: Bool, listening: Bool) -> ComposerTrailing {
        if listening { return .listening }
        if hasContent { return .send }
        if busy && canStop { return .stop }
        return .dictate
    }
}

/// The capsule's placeholder by state, short: what typing does now.
enum ComposerPlaceholder {
    static func text(fork: Bool, answering: Bool, busy: Bool) -> String {
        if fork { return "Message the fork" }
        if answering { return "Reply or answer" }
        if busy { return "Steer or queue" }
        return "Ask anything"
    }
}

/// The live line above the capsule, read from the bridge's pill (`PillRow`): the status and any
/// other live parts as one sentence, and at most one text action on the right (the queue, else
/// the goal). Every part the bridge sends stays in the line, so nothing live is dropped.
struct LiveLineParts: Equatable {
    let status: PillRow.Status?
    /// Muted words after the status in the sentence: "2 subagents", "1 command".
    let extras: [PillRow.Segment]
    /// The one text action on the right.
    let action: PillRow.Segment?
    /// What tapping the sentence opens; empty when it opens nothing.
    let opens: String

    /// Kinds that may take the action's place, in order.
    static let actionKinds = ["queue", "goal"]

    static func of(_ pill: PillRow) -> LiveLineParts {
        let action = actionKinds.lazy.compactMap { kind in pill.segments.first { $0.kind == kind && !$0.opens.isEmpty } }.first
        let extras = pill.segments.filter { $0.id != action?.id }
        // Nothing to lead with: the lone part is the sentence itself, not an action on the right.
        if pill.status == nil, extras.isEmpty, let action {
            return LiveLineParts(status: nil, extras: [action], action: nil, opens: action.opens)
        }
        let opens = pill.status.map(\.opens).flatMap { $0.isEmpty ? nil : $0 }
            ?? extras.first { !$0.opens.isEmpty }?.opens ?? ""
        return LiveLineParts(status: pill.status, extras: extras, action: action, opens: opens)
    }
}

/// Words spoken into the composer: they follow what was typed before dictation began.
enum DictationText {
    static func merged(base: String, spoken: String) -> String {
        let words = spoken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return base }
        if base.isEmpty { return words }
        let gap = base.last.map { $0.isWhitespace } == true ? "" : " "
        return base + gap + words
    }
}
