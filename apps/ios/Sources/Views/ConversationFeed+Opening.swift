import SwiftUI

/// A thread opening before its machine has answered: what the feed says meanwhile
/// (`ThreadOpening`), and how the machine's window lands under rows already on screen.
extension ConversationFeed {
    /// What the feed says while its rows aren't the machine's own yet.
    var opening: ThreadOpening {
        let row = model.inbox[thread.id] ?? thread.metadata
        return .of(.init(loaded: ready, replacing: thread.replacing, connection: model.connection,
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
    /// window's rows land and measure. Nothing is laid over the feed: the flipped collection
    /// keeps the live end where it is as rows join (ADR 0222), and a snapshot of it can draw
    /// blank. The reader's own scroll ends the hold (`endPageHold`).
    private func holdEndWhileWindowGrows() {
        guard !surface.running(.page) else { return }
        let intent = intent
        var settle = TranscriptSettle(at: CACurrentMediaTime())
        surface.untilSettled(.page, { time in
            let placed = TranscriptSettle.opened(following: true, fromEnd: Double(intent.metrics.bottom), restoring: false)
            return settle.frame([Double(intent.metrics.height)], placed: placed, at: time)
        }) { _ in
            growth.windowHoldEnded()
        }
    }
}
