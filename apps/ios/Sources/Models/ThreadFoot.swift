import Foundation

/// What sits above a thread's composer: one strip (a request, what holds the queue, a message
/// that didn't go, commands a stopped turn left running, a transfer, what stops the checkout), or
/// else the live pill, which the `@` and `/` list also takes the place of while it's open.
///
/// The page draws the pill by `drawsPill`. The transcript decides from whether the pill is
/// actually on screen, as the pill reports it (`pillVisible`), not from the reasons it may be
/// gone, so a live row is never hidden while no pill shows, for any reason.
struct ThreadFoot: Equatable, Sendable {
    var requests = false
    var hold = false
    var notSent = false
    var leftRunning = false
    var transfer = false
    var work = false
    var pill: PillRow?
    /// The composer's `@` or `/` list is open: it takes the pill's place.
    var suggesting = false
    /// The pill is on screen now, as the pill itself last reported (`ThreadScreenModel`).
    var pillVisible = false

    var stripShown: Bool { requests || hold || notSent || leftRunning || transfer || work }
    /// Whether the page draws the pill: the bridge sent one and nothing takes its place.
    var drawsPill: Bool { pill != nil && !stripShown && !suggesting }
    /// What the pill on screen names: nothing unless the pill reports itself on screen. A strip
    /// also counts as taking its place, so a report left over from before can't hide a row.
    var named: PillRow.Covers {
        guard pillVisible, !stripShown, let covers = pill?.covers else { return .nothing }
        return covers
    }
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
    /// The foot of `thread` as its page and transcript read it. The `@` and `/` list is the page's
    /// own state: it sets `suggesting` itself.
    @MainActor static func of(_ thread: ThreadModel, transfers: TransfersModel) -> ThreadFoot {
        let screen = thread.screen
        return ThreadFoot(requests: !thread.approvals.isEmpty,
                          hold: screen.queue?.strip != nil,
                          notSent: screen.queue?.notSent != nil,
                          leftRunning: screen.leftRunning != nil,
                          transfer: transfers.thread(thread.id)?.line != nil,
                          work: screen.work != nil,
                          pill: screen.pill,
                          pillVisible: screen.pillVisible)
    }
}
