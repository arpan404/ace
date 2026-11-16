import Foundation

/// What sits above a thread's composer: one strip (a request, what holds the queue, a message
/// that didn't go, commands a stopped turn left running, a transfer, what stops the checkout), or
/// else the live pill. Read here so the transcript knows whether the pill is on screen.
struct ThreadFoot: Equatable, Sendable {
    var requests = false
    var hold = false
    var notSent = false
    var leftRunning = false
    var transfer = false
    var work = false
    var pill: PillRow?

    var stripShown: Bool { requests || hold || notSent || leftRunning || transfer || work }
    /// The pill as it shows: none while a strip takes its place.
    var shownPill: PillRow? { stripShown ? nil : pill }
    /// What the pill on screen names; nothing while no pill shows.
    var named: PillRow.Covers { shownPill?.covers ?? .nothing }
}

/// A fact the pill and the transcript can both say.
enum LiveFact {
    case subagents
    case commands
}

extension PillRow.Covers {
    func names(_ fact: LiveFact) -> Bool {
        switch fact {
        case .subagents: subagents
        case .commands: commands
        }
    }

    /// Whether a fact's transcript row shows (design language: one place per fact). Once it has
    /// settled, always: the row is the record. While it is live, only when the pill on screen
    /// doesn't name it, so a live tree or command never leaves view.
    func transcriptShows(_ fact: LiveFact, live: Bool) -> Bool {
        !live || !names(fact)
    }
}

extension BlockRow.Agents {
    /// Whether the pill can stand in for this group while it is live: some child still works, waits
    /// or asks, every such child is one the pill counts and its Agents sheet lists (`counted`),
    /// and the sheet can open every child. A child the group knows from the thread list but the
    /// parent's tree doesn't (a stale copy after a reconnect) shows only here, and a child on
    /// another machine opens there only from its row here, so a group holding either keeps it.
    var leavesToPill: Bool {
        live == true && counted == true && entries.allSatisfy { $0.machine.isEmpty }
    }
}

extension BlockRow.Background {
    /// Whether the pill can stand in for a step's lines while they run: one still runs, and every
    /// running one is a command the pill counts and its Agents sheet stops (`counted`). A running
    /// task it doesn't count (a monitor) shows only on its line, so a step holding one keeps it.
    static func leaveToPill(_ lines: [BlockRow.Background]) -> Bool {
        lines.contains(where: \.running) && lines.allSatisfy { !$0.running || $0.counted == true }
    }
}

extension ThreadFoot {
    /// The foot of `thread` as its page draws it, by the order of the page's own strip chain.
    @MainActor static func of(_ thread: ThreadModel, transfers: TransfersModel) -> ThreadFoot {
        let screen = thread.screen
        return ThreadFoot(requests: !thread.approvals.isEmpty,
                          hold: screen.queue?.strip != nil,
                          notSent: screen.queue?.notSent != nil,
                          leftRunning: screen.leftRunning != nil,
                          transfer: transfers.thread(thread.id)?.line != nil,
                          work: screen.work != nil,
                          pill: screen.pill)
    }
}
