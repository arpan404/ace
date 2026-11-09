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

/// The live pills above the capsule, read from the bridge's pill (`PillRow`): the thread's status
/// first, then every other live part (subagents, commands, the queue, the goal) in the bridge's
/// order, each its own pill opening what it names. Every part the bridge sends is a pill, so
/// nothing live is dropped; a part that opens nothing is not a button.
struct LivePill: Equatable, Identifiable {
    enum Part: Equatable {
        case status(PillRow.Status)
        case segment(PillRow.Segment)
    }
    let part: Part
    /// What tapping it opens (`agents`, `queue`, `goal`); empty when it opens nothing.
    let opens: String
    var id: String {
        switch part {
        case .status: "status"
        case .segment(let segment): segment.kind
        }
    }

    static func of(_ pill: PillRow) -> [LivePill] {
        let status = pill.status.map { LivePill(part: .status($0), opens: $0.opens) }
        return (status.map { [$0] } ?? []) + pill.segments.map { LivePill(part: .segment($0), opens: $0.opens) }
    }
}

/// When the transcript offers Scroll to end: whenever its end is out of view by more than the
/// slack, or the rows held stop short of the live end (a history window not joined to it). A
/// feed that follows the end keeps itself there, so streaming never flickers the button.
enum TranscriptEndButton {
    struct Facts: Equatable {
        /// How far the end is below the viewport's bottom edge, in points.
        let fromEnd: Double
        let slack: Double
        let following: Bool
        /// The rows shown are a history window that hasn't reached the live end.
        let windowApart: Bool
    }

    static func shows(_ facts: Facts) -> Bool {
        if facts.windowApart { return true }
        if facts.following { return false }
        return facts.fromEnd > facts.slack
    }

    /// A feed still following the end at rest, but more than a screen from it, was moved by
    /// something other than the person's own drag (a tap on the status bar, VoiceOver): it stops
    /// following, so the button shows and the next streamed line doesn't pull the reader back.
    static func leftByOtherScroll(following: Bool, fromEnd: Double, viewport: Double, settling: Bool) -> Bool {
        following && !settling && viewport > 0 && fromEnd > viewport
    }
}
