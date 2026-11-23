import SwiftUI

/// What the feed does as the reading window, the keyboard, its lifecycle and the person's
/// navigation change: returning to the end, revealing, holding an older page, turns and jumps.
extension ConversationFeed {
    /// A sent message or a Scroll to end tap: back to the live end, following it.
    func returnToEnd(proxy: TranscriptSurface) {
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
    func windowReplaced(proxy: TranscriptSurface) {
        extent.update(change: TranscriptExtent.WindowChange(
            ids: shown.screen.blockOrder.map { "block:\($0)" }, movement: .replace))
        let rows: [TranscriptFeedRow] = TranscriptFeedRow.rows(shown)
        anchor.lastBlockItems = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0.block.row.items) })
    }
    /// The history window's rows changed: restore, focus or hold the reader's place.
    func readingRevised(proxy: TranscriptSurface) {
        guard reading.thread != nil else { return }
        if UIAccessibility.isVoiceOverRunning { viewport.clearSessionAnchor() }
        if intent.appendedRevision == reading.revision { return }
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
                        surface.scroll(to: session.rowID, anchor: .center)
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
                if rows.indices.contains(index) { surface.scroll(to: rows[index].id, anchor: .center) }
            case .end, .none: break
            }
        }
        pageIfNeeded(proxy)
    }
    func threadLoaded(_ loaded: Bool, proxy: TranscriptSurface) {
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
    func keyboardWillMove(proxy: TranscriptSurface) {
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
    func keyboardLanded(proxy: TranscriptSurface) {
        var instant = Transaction()
        instant.disablesAnimations = true
        withTransaction(instant) {
            if keyboardFollow.landed(lift: Double(keyboardLift)) { surface.scroll(to: TranscriptTail.id, anchor: .top) }
        }
        keyboardMoving = false
        // The scroll's target is above it, so it goes without moving the rows.
        if keyboardRoom.leaving > 0 { withTransaction(instant) { keyboardRoom.settled() } }
        // Text that streamed in while the keyboard moved.
        if pinned && !intent.active { toEnd(proxy) }
    }
    func appeared(proxy: TranscriptSurface) {
        TranscriptJumpHooks.begin("open", hidden: !revealed)
        model.prepareReadingAnswers = transcriptMarkdown?.prepare
        model.admitsOlderAppend = { reply, patches in
            guard let base = reading.thread, !reading.landing.holdsPlace,
                  viewport.sessionAnchor == nil, reply.freshness != .cached,
                  (reply.evictedLeading ?? []).isEmpty else { return false }
            let shown = reading.shown ?? thread
            let retainedNewer = Set(reply.evictedTrailing ?? [])
            let metrics = intent.metrics
            let bottom = metrics.viewport - metrics.bottomInset
            guard extent.hasMeasuredNewerRows(retainedNewer),
                  retainedNewer.allSatisfy({ id in
                      guard let frame = anchor.keeper.frames.frame("block:\(id)") else { return true }
                      return frame.minY >= bottom
                  }) else { return false }
            // Protect the viewport and half a screen ahead. A turn cut by the previous page
            // can regroup further ahead without changing the coordinates of these rows.
            let ahead = metrics.topInset - metrics.viewport / 2
            let oldestProtected = shown.screen.blockOrder.first { id in
                guard let frame = anchor.keeper.frames.frame("block:\(id)") else { return false }
                return frame.minY < bottom && frame.maxY > ahead
            }
            return TranscriptHistoryAppend.preservesRows(patches, replacing: base, shown: shown,
                                                        oldestProtected: oldestProtected, retainedNewer: retainedNewer)
        }
        model.readingWillMove = {
            if model.publishingOlderAppend {
                intent.olderPage = false
                TranscriptJumpHooks.note("older append")
            } else {
                captureTop()
                if reading.operation == "older" { holdOlderPage() }
            }
        }
        // The window the thread opened from (kept rows, a screenful) grows: held in place.
        model.liveWindowWillGrow = { liveWindowWillGrow() }
        model.readingMoved = {
            reading.moved()
            if model.publishingOlderAppend {
                // Replacing newer rows with their spacer and appending older rows is one update.
                updateExtent(rows: TranscriptFeedRow.rows(shown))
                intent.appendedRevision = reading.revision
                intent.rearmAfterAppend = true
            }
        }
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
        transcriptMarkdown?.moving = false
        model.prepareReadingAnswers = nil
        model.admitsOlderAppend = nil
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
    func roomChanged(by growth: CGFloat, motion: Animation?, proxy: TranscriptSurface) {
        // Rows riding the keyboard (`KeyboardRide`) catch up with the end when they land.
        guard !intent.active, growth != 0, !keyboardFollow.riding, pinned || intent.metrics.bottom + growth < 0 else { return }
        // The room has its new height in this same update, so the end is where the scroll lands,
        // starting in the same frame as the keyboard.
        settle.cancel()
        holdEndWhileRoomGrows(by: growth)
        toEnd(proxy, animated: motion != nil)
    }
    /// A growing bar's room lands in one update, and rows above the screen may measure after it:
    /// the bottom holds still until the content has held for two frames (`TranscriptSettle`), so
    /// rows never move down under the reader.
    private func holdEndWhileRoomGrows(by growth: CGFloat) {
        guard !surface.running(.page), self.growth.roomGrowing(following: pinned, by: Double(growth)) else { return }
        let intent = intent
        var held = TranscriptSettle(at: CACurrentMediaTime())
        surface.untilSettled(.page, { time in
            let placed = TranscriptSettle.opened(following: true, fromEnd: Double(intent.metrics.bottom), restoring: false)
            return held.frame([Double(intent.metrics.height)], placed: placed, at: time)
        }) { _ in self.growth.windowHoldEnded() }
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
    /// An older page is about to join above the reader's line. The collection's layout keeps the
    /// reader's row where it is on screen as the page lands (ADR 0222), so nothing is frozen or
    /// moved here: a hold that shifted the offset each frame fought a fling still decelerating.
    func holdOlderPage() {
        intent.olderPage = false
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
    func toEnd(_ proxy: TranscriptSurface, animated: Bool = false) {
        // Before the rows land there is no end to reach: a settle started on the placeholder
        // would hold the budget the first real scroll to the end needs.
        guard ready, !settle.isRunning else { return }
        surface.scroll(to: TranscriptTail.id, anchor: .top, animated: animated)
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
                   }) { surface.scroll(to: TranscriptTail.id, anchor: .top) }
    }
    /// The previous or next turn from the one at the top of the screen: its ask scrolls to the
    /// top. Past the rows held, an earlier turn pages older history in; after the last, the end.
    func stepTurn(_ direction: Int, proxy: TranscriptSurface) {
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
    func jump(to row: TranscriptFeedRow, proxy: TranscriptSurface) {
        keep(.jumped(row.id), proxy: proxy)
        surface.scroll(to: row.id, anchor: .bottom, animated: !reduceMotion)
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
    func readerTookOver(_ proxy: TranscriptSurface) {
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
