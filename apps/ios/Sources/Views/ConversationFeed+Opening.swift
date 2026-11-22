import SwiftUI

/// A thread opening before its machine has answered: what the feed says meanwhile
/// (`ThreadOpening`), and how the machine's window lands under rows already on screen.
extension ConversationFeed {
    /// What the feed says while its rows aren't the machine's own yet.
    var opening: ThreadOpening {
        let row = model.inbox[thread.id] ?? thread.metadata
        return .of(.init(loaded: ready, rows: thread.screen.blockOrder.count, connection: model.connection,
                         problem: model.problem?.message, machine: row?.machine))
    }

    /// Retry from the opening's placeholder or its syncing line (`ClientModel.retryOpening`).
    func retryOpening() { model.retryOpening(thread.id) }

    /// The live window is about to grow under rows already shown (`ClientModel.liveWindowWillGrow`):
    /// kept rows from an earlier session, or the opening's tail, meeting the machine's whole
    /// window. A reader at the end keeps the newest message where it is; one reading back keeps
    /// the row on top (`holdOlderPage`).
    func liveWindowWillGrow() {
        guard revealed, reading.thread == nil else { return }
        switch growth.windowGrowing(following: pinned) {
        case .end: holdEndWhileWindowGrows()
        case .topRow:
            intent.olderPage = true
            captureTop()
            holdOlderPage()
        }
    }

    /// Size changes keep the bottom still (`TranscriptGrowthAnchor.windowGrowing`) while the
    /// window's rows land and measure; what is drawn is frozen over the feed meanwhile, so the
    /// rows show once, in place, at the end. The reader's own scroll ends it (`endPageHold`).
    /// Under VoiceOver and Switch Control nothing is frozen: the feed makes no automatic
    /// corrections there, and only the bottom holds.
    private func holdEndWhileWindowGrows() {
        guard !surface.running(.page) else { return }
        let frozen = !Self.assistiveScrolling && surface.freeze()
        if frozen { TranscriptJumpHooks.covered(true) }
        let intent = intent, surface = surface
        var settle = TranscriptSettle(at: CACurrentMediaTime())
        surface.untilSettled(.page, { time in
            let placed = TranscriptSettle.opened(following: true, fromEnd: Double(intent.metrics.bottom), restoring: false)
            return settle.frame([Double(intent.metrics.height)], placed: placed, at: time)
        }) { _ in
            growth.windowHoldEnded()
            guard frozen else { return }
            surface.thaw()
            TranscriptJumpHooks.covered(false)
        }
    }
}
