import SwiftUI

/// What the feed does as the reading window, the keyboard, its lifecycle and the person's
/// navigation change: returning to the end, revealing, holding an older page, turns and jumps.
extension ConversationFeed {
    /// A sent message or a Scroll to end tap: back to the live end, following it.
    func returnToEnd(proxy: ScrollViewProxy) {
        readerTookOver(proxy)
        reading.toEnd(model: model, thread: thread)
        setFollowing(true)
        toEnd(proxy)
    }
    func disclosuresChanged() {
        readerMovedFeed()
        intent.opened = true
        // Anchor the disclosure while reading history; the live end keeps following.
        if !following || reading.thread != nil, let top = currentTopRow() {
            viewport.toggle(rowID: top.rowID, itemID: top.itemID, top: top.top)
        }
        applyLayoutRevision()
    }
    /// A new history window: its rows replace the extent's.
    func windowReplaced(proxy: ScrollViewProxy) {
        extent.update(change: TranscriptExtent.WindowChange(
            ids: shown.screen.blockOrder.map { "block:\($0)" }, movement: .replace))
        let rows: [TranscriptFeedRow] = TranscriptFeedRow.rows(shown)
        anchor.lastBlockItems = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0.block.row.items) })
        restack(rows: rows.count, moving: intent.active || intent.animating, replaced: true, proxy: proxy)
    }
    /// The rows' count changed, their window was replaced, or the feed came to rest: move the rows
    /// to the other stack if `TranscriptStackChoice` says so. A switch lays every row out again,
    /// so the reader's place is installed as a session anchor, restored once the rows measure, and
    /// a feed following the end goes back to it.
    func restack(rows: Int, moving: Bool, replaced: Bool, proxy: ScrollViewProxy) {
        guard ready, anchor.stack.update(rows: rows, moving: moving, replaced: replaced) != nil else { return }
        if !following, let top = currentTopRow() {
            viewport.noteSessionAnchor(TranscriptHeldAnchor(rowID: top.rowID, itemID: top.itemID, top: top.top))
        }
        stackSwitches += 1
        PerfProbe.add("feed.restacks", 1)
        if following { toEnd(proxy) }
    }
    /// The history window's rows changed: restore, focus or hold the reader's place.
    func readingRevised(proxy: ScrollViewProxy) {
        guard reading.thread != nil else { return }
        if UIAccessibility.isVoiceOverRunning { viewport.clearSessionAnchor() }
        let rows = TranscriptFeedRow.rows(shown)
        updateExtent(rows: rows)
        if reading.landing.holdsPlace {
            // A focus still landing owns the place until its row has been shown: no saved
            // session or held row takes it over, whatever row is on top as pages land.
            viewport.clearSessionAnchor()
            place(.revised, proxy: proxy)
        } else if let session = viewport.sessionAnchor, rows.contains(where: { $0.id == session.rowID }) {
                // Session restore owns this pass: a center jump would lose
                // the saved pixel offset. Coarse-scroll until the row
                // measures, then refine to the exact offset below.
                if anchor.keeper.frames.frame(session.rowID) == nil {
                    if viewport.correctionFrames == 0 {
                        proxy.scrollTo(session.rowID, anchor: .center)
                    }
                    viewport.noteCorrectionApplied()
                } else {
                    applySessionRestore(proxy: proxy)
                }
        } else {
            // Post-measurement layout event: apply the pending semantic
            // anchor correction, if the viewport still owes one. Gestures
            // cancel what is owed, so a drag never fights a restore.
            let locate: (String) -> (key: String, index: Int, top: Double)? = { key in
                if let index = rows.firstIndex(where: { $0.id == key }) {
                    return (key: key, index: index, top: rowTop(key))
                }
                if let index = rows.firstIndex(where: { $0.block.row.items.contains(key) }) {
                    return (key: rows[index].id, index: index, top: rowTop(rows[index].id))
                }
                return nil
            }
            let correction = viewport.residentChanged(
                newKeys: rows.map(\.id),
                locate: locate,
                successorOf: { self.itemSuccessor(for: $0, rows: rows) },
                now: model.now())
            switch correction {
            case .shift:
                if let held = viewport.held,
                    placeRowAtTop(held.rowID, top: held.top, proxy: proxy) {
                    viewport.noteCorrectionApplied()
                    keep(.placedHeldRow, proxy: proxy)
                }
            case .aim(let index):
                if rows.indices.contains(index) { proxy.scrollTo(rows[index].id, anchor: .center) }
            case .end, .none: break
            }
        }
        pageIfNeeded(proxy)
    }
    func threadLoaded(_ loaded: Bool, proxy: ScrollViewProxy) {
        guard loaded else { focusRequested(); return }
        restoreSessionIfReady()
        if !initialScroll {
            if following { toEnd(proxy) }
            growth.opened(atEnd: following)
            initialScroll = true
        }
        focusRequested()
    }
    /// A fresh complete window on reconnect before clearing stale: the bridge resets its stale
    /// window and loads around the anchor item, so never merge old cached chunks with new
    /// authoritative rows.
    func connectionChanged(_ connection: String) {
        if connection == "ready", reading.thread != nil, !reading.loading {
            reading.refreshAfterReconnect(model: model, live: thread, anchorItemId: currentAnchorItemID())
        }
    }
    /// The keyboard is moving (`KeyboardRide`), and the composer with it. Rows following the end
    /// are drawn up by the same lift in the same frames, so the two move as one (#2170): an animated
    /// scroll can't, as it runs on the scroll view's own curve and starts frames late. The room
    /// changes at once; only drawing moves until the ride lands (`keyboardLanded`), and the only
    /// part of the feed it brings into view is the empty room under the last row.
    func keyboardWillMove(proxy: ScrollViewProxy) {
        let lift = keyboard.target
        guard lift != keyboardLift else { return }
        let growth = lift - keyboardLift
        let follows = !intent.active && (pinned || intent.metrics.bottom + growth < 0)
        readerMovedFeed()
        keyboardMoving = true
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) {
            // The scroll allows for the lift it last landed on.
            keyboardFollow.moveStarted(lift: Double(keyboardLift), follows: follows)
            keyboardRoom.moved(to: Double(lift))
        }
        if follows { settle.cancel() }
        // Without motion the lift is already there.
        if !keyboard.running { keyboardLanded(proxy: proxy) }
    }
    /// The keyboard and the composer have landed: rows riding with them hand their offset to the
    /// scroll in one frame that moves nothing, and the closing keyboard's room below the end goes.
    func keyboardLanded(proxy: ScrollViewProxy) {
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) {
            if keyboardFollow.landed(lift: Double(keyboardLift)) { proxy.scrollTo(TranscriptTail.id, anchor: .bottom) }
        }
        keyboardMoving = false
        // The scroll's target is above it, so it goes without moving the rows.
        if keyboardRoom.leaving > 0 { withTransaction(instant) { keyboardRoom.settled() } }
        // Text that streamed in while the keyboard moved.
        if pinned && !intent.active { toEnd(proxy) }
    }
    func appeared(proxy: ScrollViewProxy) {
        TranscriptJumpHooks.begin("open", hidden: !revealed)
        model.readingWillMove = { captureTop(); holdOlderPage() }
        // The window the thread opened from (kept rows, a screenful) grows: held in place.
        model.liveWindowWillGrow = { liveWindowWillGrow() }
        model.readingMoved = { reading.moved() }
        model.onReadingNeedsFresh = Self.rebuildOnOverflow(anchor: anchor, intent: intent, reading: reading, thread: thread, model: model)
        restoreSessionIfReady()
        applyLayoutRevision()
        // Held from before the rows land, so the first frame that has them already lays out from
        // the end.
        if !initialScroll { growth.opened(atEnd: following) }
        if thread.loaded, !initialScroll {
            if following { toEnd(proxy) }
            initialScroll = true
        }
    }
    /// Overflow recovery hook: fired once after the gesture ends (or the page settles) when the
    /// held queue discarded rows with no fresh reset yet. Rebuilds authoritatively around the
    /// saved item anchor; old rows stay readable until the replacement publishes, and the hold
    /// clears `needsFresh` only on that fresh flush. Captures only class-backed state so the
    /// closure never goes stale.
    static func rebuildOnOverflow(anchor: TranscriptReadingAnchor, intent: TranscriptScrollIntent,
                                          reading: TranscriptReading, thread: ThreadModel, model: ClientModel) -> () -> Void {
        return {
            guard reading.thread != nil, !reading.loading else { return }
            let shown: ThreadModel = reading.shown ?? thread
            let topID = anchor.keeper.frames.topRow(inset: intent.metrics.topInset, containing: {
                TranscriptFeedRow.block($0, in: shown) != nil
            })
            let item = topID.flatMap { TranscriptFeedRow.block($0, in: shown)?.row.items.first } ?? reading.lastAnchorItemId
            if let item { reading.rebuild(model: model, live: thread, anchorItemId: item) }
        }
    }
    func disappeared() {
        settle.cancel()
        surface.stopAll()
        surface.thaw()
        saveSession()
        reading.cancel(model: model)
        model.readingWillMove = nil
        model.readingMoved = nil
        model.liveWindowWillGrow = nil
        model.onReadingNeedsFresh = nil
    }
    func windowJoined(_ joined: Bool) {
        if joined, reading.thread != nil, !intent.active, intent.metrics.bottom <= AceDesign.Space.group { setFollowing(true) }
        updateBehind()
    }
    /// Shows or hides Scroll to end by where the end is now (`TranscriptEndButton`); writes only
    /// on a change, so a scroll's frames don't re-evaluate the thread.
    func updateBehind() {
        let shows = TranscriptEndButton.shows(.init(fromEnd: Double(intent.metrics.bottom), slack: Double(AceDesign.Space.group),
                                                    following: following, windowApart: reading.thread != nil && !reading.joined))
        if behind != shows { behind = shows }
    }
    /// The room at the end changed (the composer or its strip). Following the end,
    /// the last row moves with it, in the same motion; reading elsewhere, the rows stay put and
    /// are covered, unless the smaller room would park the view past the end.
    func roomChanged(by growth: CGFloat, motion: Animation?, proxy: ScrollViewProxy) {
        // Rows riding the keyboard (`KeyboardRide`) catch up with the end when they land.
        guard !intent.active, growth != 0, !keyboardFollow.riding, pinned || intent.metrics.bottom + growth < 0 else { return }
        // The room has its new height in this same update, so the end is where the scroll lands,
        // starting in the same frame as the keyboard.
        settle.cancel()
        withAnimation(motion) { toEnd(proxy) }
    }
    /// A thread opening draws its first frames short of where it opens: lazy rows correct their
    /// heights and the scroll catches up with the end. The rows stay hidden until the content's
    /// height and offset have held for two frames with the feed at the end it follows, a quarter
    /// second at most (`TranscriptSettle`), then show there in one frame (ADR 0157). A saved
    /// place being reopened counts as not yet placed until its row is back where it was.
    func revealWhenSettled() {
        let intent = intent
        // The screen this reveal draws: a reload or reconnect reopens the same thread under a
        // newer generation or runtime, whose first screen this one isn't.
        let screen = model.showing(thread)
        let started = CACurrentMediaTime()
        var settle = TranscriptSettle(at: started)
        surface.untilSettled(.reveal, { time in
            let metrics = intent.metrics
            let placed = TranscriptSettle.opened(following: pinned, fromEnd: Double(metrics.bottom),
                                                 restoring: viewport.sessionAnchor != nil || reading.loading)
            let watched = TranscriptSettle.watched(following: pinned, height: Double(metrics.height), offset: Double(metrics.y))
            return settle.frame(watched, placed: placed, at: time)
        }) { outcome in
            var still = Transaction()
            still.disablesAnimations = true
            withTransaction(still) { revealed = true }
            model.threadShown(thread, at: screen)
            TranscriptJumpHooks.revealed(after: CACurrentMediaTime() - started, capped: outcome == .capped)
            TranscriptJumpHooks.landed { Double(intent.metrics.bottom) }
        }
    }
    /// An older page is about to join above the reader's line. What is drawn is frozen over the
    /// feed while its rows land and measure; each frame the row on top is put back at its height
    /// on screen from its own measured frame, then the feed thaws (`TranscriptSurface`).
    func holdOlderPage() {
        // Under VoiceOver and Switch Control the feed makes no automatic corrections, so none here
        // either.
        guard intent.olderPage, !surface.running(.page), !Self.assistiveScrolling, let top = currentTopRow(),
              let held = anchor.keeper.frames.inContent(top.rowID) else { return }
        let onScreen = Double(held.minY) - surface.offset
        // A feed still hidden on open has nothing drawn to freeze: its row is held all the same,
        // and the reveal, running on its own, shows it once both have settled.
        let frozen = revealed
        if frozen {
            guard surface.freeze() else { return }
            TranscriptJumpHooks.covered(true)
        }
        intent.olderPage = false
        let anchor = anchor, intent = intent, surface = surface
        var settle = TranscriptSettle(at: CACurrentMediaTime())
        surface.untilSettled(.page, { time in
            guard let frame = anchor.keeper.frames.inContent(top.rowID) else {
                return settle.frame([], placed: false, at: time)
            }
            let drift = Double(frame.minY) - surface.offset - onScreen
            let placed = abs(drift) < TranscriptSettle.tolerance
            if !placed { surface.shift(by: drift) }
            return settle.frame([Double(frame.minY), Double(intent.metrics.height)], placed: placed, at: time)
        }) { _ in
            guard frozen else { return }
            surface.thaw()
            TranscriptJumpHooks.covered(false)
        }
    }
    /// The reader took the feed mid-hold: it's theirs as it is.
    /// An assistive technology may scroll the feed without a touch it can see.
    static var assistiveScrolling: Bool { UIAccessibility.isVoiceOverRunning || UIAccessibility.isSwitchControlRunning }
    func endPageHold() {
        surface.stop(.page)
        // A window's bottom hold ends with it, whatever ended it (`windowHoldEnded`).
        growth.windowHoldEnded()
        guard surface.isFrozen else { return }
        surface.thaw()
        TranscriptJumpHooks.covered(false)
    }
    func toEnd(_ proxy: ScrollViewProxy) {
        // Before the rows land there is no end to reach: a settle started on the placeholder
        // would hold the budget the first real scroll to the end needs.
        guard ready, !settle.isRunning else { return }
        proxy.scrollTo(TranscriptTail.id, anchor: .bottom)
        let intent = intent
        guard !UIAccessibility.isVoiceOverRunning else { return }
        // An animated scroll the settle waits on is one still moving the rows: a scroll with
        // nowhere to go can leave the phase reading "animating" with nothing in flight.
        var lastY = intent.metrics.y
        settle.run(gap: { pinned && !intent.active && !keyboardMoving ? intent.metrics.toEnd : nil },
                   wait: {
                       let moving = intent.animating && intent.metrics.y != lastY
                       lastY = intent.metrics.y
                       return moving
                   }) { proxy.scrollTo(TranscriptTail.id, anchor: .bottom) }
    }
    /// The previous or next turn from the one at the top of the screen: its ask scrolls to the
    /// top. Past the rows held, an earlier turn pages older history in; after the last, the end.
    func stepTurn(_ direction: Int, proxy: ScrollViewProxy) {
        readerTookOver(proxy)
        let rows = TranscriptFeedRow.rows(shown)
        let starts = rows.indices.filter { rows[$0].block.row.kind == "user" }
        let top = intent.metrics.topInset
        let first = rows.firstIndex { (anchor.keeper.frames.frame($0.id)?.maxY ?? -.infinity) > top + 1 } ?? rows.count - 1
        setFollowing(false)
        if direction > 0 {
            if let next = starts.first(where: { $0 > first }) { jump(to: rows[next], proxy: proxy); return }
            reading.toEnd(model: model, thread: thread); setFollowing(true); toEnd(proxy)
            return
        }
        let here = starts.last { $0 <= first }
        let sitsBelow = here.map { (anchor.keeper.frames.frame(rows[$0].id)?.minY ?? top) < top - AceDesign.Space.related } ?? false
        if let here, here < first || sitsBelow { jump(to: rows[here], proxy: proxy); return }
        if let previous = starts.last(where: { $0 < (here ?? first) }) { jump(to: rows[previous], proxy: proxy); return }
        if reading.thread == nil ? thread.screen.hasOlder : reading.hasOlder { reading.read("older", model: model, live: thread, anchorItemId: currentAnchorItemID()) }
    }
    /// Scrolls the turn's ask to the top and holds it, never the turn the reader left, refreshed
    /// to where it lands (`TranscriptPlaceKeeper`).
    func jump(to row: TranscriptFeedRow, proxy: ScrollViewProxy) {
        keep(.jumped(row.id), proxy: proxy)
        withAnimation { proxy.scrollTo(row.id, anchor: .top) }
    }
    /// A search hit asked for an item in this thread: the shared window opens around it.
    func focusRequested() {
        guard thread.loaded, let focus = model.focusOnOpen, focus.thread == thread.id else { return }
        model.focusOnOpen = nil
        setFollowing(false)
        if let turn = focus.turn { reading.jump(toTurn: turn, model: model, live: thread) }
        else { reading.jump(to: focus.item, model: model, live: thread) }
    }
    /// The reader took the feed somewhere themselves (a drag, a turn key, Scroll to end, a
    /// send, VoiceOver): a focus still landing or still awaited stops pulling them back.
    func readerTookOver(_ proxy: ScrollViewProxy) {
        place(.takeover, proxy: proxy)
        // Rows riding the keyboard stay where the scroll has them, and its landing leaves them
        // there instead of going to the end under the reader's finger.
        if keyboardFollow.riding {
            var instant = Transaction()
            instant.disablesAnimations = true
            withTransaction(instant) { keyboardFollow.readerTookOver() }
        }
    }
    /// The row showing `item` in the history window, for a landing focus.
    func rowShowing(_ item: String) -> String? {
        reading.shown.flatMap { TranscriptFeedRow.rows($0).first { $0.block.row.items.contains(item) }?.id }
    }
    /// Retry stale history: re-ask the bridge around the reader's anchor item
    /// so the rebuild loads fresh rows instead of merging cached chunks.
    func retryHistory() {
        if historyStale {
            reading.refreshAfterReconnect(model: model, live: thread, anchorItemId: currentAnchorItemID())
            if !reading.loading, reading.thread == nil { reading.retry(model: model, live: thread) }
        } else {
            reading.retry(model: model, live: thread)
        }
    }
}
