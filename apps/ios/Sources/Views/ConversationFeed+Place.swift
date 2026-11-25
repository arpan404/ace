import SwiftUI

/// Keeping the reader's place: restoring a saved place, holding the top row through layout,
/// placing rows, the saved session, the content's extent and paging at its edges.
extension ConversationFeed {
    /// Refine a pending session restore to its saved pixel offset once the row
    /// has measured. No-ops (keeping the restore pending) until the frame
    /// arrives; clears once the frame settles within tolerance, and the
    /// viewport budget (or a gesture) cancels a restore that never settles.
    func applySessionRestore(proxy: TranscriptSurface) {
        guard let session = viewport.sessionAnchor,
            let frame = anchor.keeper.frames.frame(session.rowID) else { return }
        let metrics = intent.metrics
        let top = Double(frame.minY) - Double(metrics.topInset)
        if TranscriptRowPlacement.settled(top: top, target: session.top) {
            viewport.clearSessionAnchor()
            return
        }
        if shiftRow(session.rowID, toTop: session.top) {
            // Put back by its drift, already counted in the frames: settled unless the content's
            // end stopped it short, in which case the next layout checks where it landed.
            if let now = anchor.keeper.frames.top(session.rowID, inset: metrics.topInset),
               TranscriptRowPlacement.settled(top: now, target: session.top) {
                viewport.noteCorrectionApplied()
                viewport.clearSessionAnchor()
                return
            }
        } else if let fraction = viewport.sessionRestoreFraction(
            viewport: Double(metrics.viewport),
            topInset: Double(metrics.topInset), bottomInset: Double(metrics.bottomInset),
            rowHeight: Double(frame.height)) {
            surface.scroll(to: session.rowID, anchor: UnitPoint(x: 0, y: 1 - fraction))
        } else {
            surface.scroll(to: session.rowID, anchor: .bottom)
        }
        viewport.noteCorrectionApplied()
    }
    /// The reader's semantic anchor item: the first item of the topmost visible
    /// row, falling back to the viewport's captured anchor.
    func currentAnchorItemID() -> String? {
        currentTopRow()?.itemID ?? viewport.held?.itemID
    }
    /// The topmost visible row with its first item and pixel top, for anchor
    /// capture, successor search and session restore.
    func currentTopRow() -> (rowID: String, itemID: String?, top: Double)? {
        let inset = intent.metrics.topInset
        let window = shown
        guard let id = anchor.keeper.frames.topRow(inset: inset, containing: {
            TranscriptFeedRow.block($0, in: window) != nil
        }), let block = TranscriptFeedRow.block(id, in: window) else { return nil }
        return (rowID: id, itemID: block.row.items.first, top: anchor.keeper.frames.top(id, inset: inset) ?? 0)
    }
    /// Takes the row at the top as the one to hold.
    func captureTop() {
        guard let top = currentTopRow() else { return }
        viewport.noteCaptured(rowID: top.rowID, itemID: top.itemID, top: top.top)
    }
    /// A row's pixel top in viewport coordinates, for the viewport controller.
    func rowTop(_ rowID: String) -> Double {
        anchor.keeper.frames.top(rowID, inset: intent.metrics.topInset) ?? 0
    }
    /// A row was laid out at `frame` in the content: on coming on screen, or when it or a row
    /// above it changed height. Heights feed the extent; the place keeper puts a held row back.
    func rowLaidOut(_ id: String, frame: CGRect, proxy: TranscriptSurface) {
        keep(.laidOut(id, frame), proxy: proxy)
        let change = anchor.keeper.lastLayout
        if change == .unchanged { return }
        PerfCounters.bump("row.layout.\(change)")
        if change != .moved {
            anchor.measured(id, height: frame.height, returning: change == .appeared)
            extent.measure(id, height: Double(frame.height))
        }
        // A pending session restore re-runs after the row actually measures, since revision
        // events land before lazy remeasurement. A landing focus re-aims in `place`.
        if !reading.landing.holdsPlace, viewport.sessionAnchor?.rowID == id { applySessionRestore(proxy: proxy) }
    }
    /// The feed scrolled: the content's top is at `origin` on screen. No row is touched.
    func contentScrolled(to origin: CGFloat, proxy: TranscriptSurface) {
        if intent.active, !reading.landing.holdsPlace, viewport.sessionAnchor == nil {
            anchor.keeper.trackOrigin(origin)
            return
        }
        let before = anchor.keeper.frames.origin
        keep(.origin(origin), proxy: proxy)
        if anchor.keeper.frames.origin != before, viewport.sessionAnchor != nil { applySessionRestore(proxy: proxy) }
    }
    /// What the feed allows the place keeper now.
    func placeFacts() -> TranscriptPlaceKeeper.Facts {
        let restoring = viewport.sessionAnchor != nil
        return TranscriptPlaceKeeper.Facts(held: viewport.held, inset: intent.metrics.topInset,
            mayCapture: viewport.mode == .reading && !viewport.isAiming && !restoring,
            mayCorrect: viewport.canCorrect && !viewport.isAiming && !restoring && viewport.mode != .following
                && !UIAccessibility.isVoiceOverRunning)
    }
    /// Hands `event` to the place keeper and does what it decides: hold a row, or scroll one back.
    /// Pure-geometry drift (async Markdown and media sizing) is corrected there, bounded by the
    /// viewport's budget and never during a gesture, a jump re-aiming, VoiceOver or following.
    func keep(_ event: TranscriptPlaceKeeper.Event, proxy: TranscriptSurface) {
        place(.keeper(event), proxy: proxy)
    }
    /// Routes `event` between the place keeper and a landing focus (`TranscriptFeedPlace`) and
    /// does what they decide. The landing is written back only when it changed, so a scroll
    /// with no focus landing writes nothing the feed observes.
    func place(_ event: TranscriptFeedPlace.Event, proxy: TranscriptSurface) {
        let metrics = intent.metrics
        // The composer and keyboard float over the feed's bottom edge, inside its insets.
        let geometry = TranscriptFocusLanding.Geometry(viewport: Double(metrics.viewport),
            topInset: Double(metrics.topInset), bottomInset: Double(metrics.bottomInset),
            covered: Double(barHeight + keyboardLift))
        let facts = TranscriptFeedPlace.Facts(keeper: placeFacts(), geometry: geometry, rowShowing: rowShowing)
        var landing = reading.landing
        let actions = TranscriptFeedPlace.next(event, keeper: &anchor.keeper, landing: &landing, facts: facts, now: model.now())
        if landing != reading.landing { reading.landing = landing }
        for action in actions {
            switch action {
            case .hold(let id, let top):
                let item = viewport.held?.rowID == id ? viewport.held?.itemID
                    : TranscriptFeedRow.block(id, in: shown)?.row.items.first
                viewport.noteCaptured(rowID: id, itemID: item, top: top)
            case .place(let id, let top):
                if !placeRowAtTop(id, top: top, proxy: proxy) { surface.scroll(to: id, anchor: .bottom) }
                viewport.noteCorrectionApplied()
            case .aim(let id, let fraction):
                surface.scroll(to: id, anchor: fraction.map { UnitPoint(x: 0, y: 1 - $0) } ?? .center)
            case .released: pageIfNeeded(proxy)
            }
        }
    }
    /// Scroll so `rowID` sits `top` points below the viewport top. Returns
    /// false when the row fills the viewport (caller falls back to top
    /// alignment). Fraction math keeps partial rows as well as top-aligned
    /// ones, like the capture/restore fraction.
    @discardableResult
    func placeRowAtTop(_ rowID: String, top: Double, proxy: TranscriptSurface) -> Bool {
        if shiftRow(rowID, toTop: top) { return true }
        guard let frame = anchor.keeper.frames.frame(rowID) else { return false }
        let metrics = intent.metrics
        guard let fraction = TranscriptAnchorPlacement.fraction(top: top,
            viewport: Double(metrics.viewport), topInset: Double(metrics.topInset),
            bottomInset: Double(metrics.bottomInset), rowHeight: Double(frame.height)) else { return false }
        surface.scroll(to: rowID, anchor: UnitPoint(x: 0, y: 1 - fraction))
        return true
    }
    /// Puts a measured `rowID` back `top` points below the header by moving the scroll its drift,
    /// in one frame, as an older page's hold does. Exact for a row of any height: an anchor
    /// fraction for a row about the screen's height throws it (`TranscriptAnchorPlacement`).
    /// False until the row has measured and the scroll view is found.
    func shiftRow(_ rowID: String, toTop top: Double) -> Bool {
        guard surface.attached, let now = anchor.keeper.frames.top(rowID, inset: intent.metrics.topInset) else { return false }
        // Noted at once: a second restore before SwiftUI reports the new origin would add it again.
        if let drift = TranscriptRowPlacement.drift(top: now, target: top) { anchor.keeper.shifted(by: surface.shift(by: drift)) }
        return true
    }
    /// Item-level successor for a gone held row: the row holding the smallest
    /// creation sequence past the removed item's, from the bounded removal log.
    /// Nil falls back to the controller's positional successor scan.
    func itemSuccessor(for goneRowID: String, rows: [TranscriptFeedRow]) -> (key: String, index: Int, top: Double)? {
        guard let heldItem = viewport.held?.itemID,
            let removal = shown.recentRemovals.first(where: { $0.id == heldItem }),
            let removedSeq = removal.seq else { return nil }
        var best: (key: String, index: Int, top: Double)?
        var bestSeq = Int.max
        for (index, row) in rows.enumerated() {
            for item in row.block.row.items {
                guard let seq = shown.items[item]?.row.creationSeq,
                    seq > removedSeq, seq < bestSeq else { continue }
                bestSeq = seq
                best = (key: row.id, index: index, top: rowTop(row.id))
            }
        }
        return best
    }
    func prefixedBlock(_ raw: String) -> String {
        raw.hasPrefix("block:") ? raw : "block:\(raw)"
    }
    func prefixedBlocks(_ raw: [String]?) -> [String] {
        (raw ?? []).map(prefixedBlock)
    }
    func currentRevision() -> TranscriptLayoutRevision {
        TranscriptLayoutRevision.current(
            width: Double(feedSize.width > 0 ? feedSize.width : intent.metrics.viewport),
            height: Double(intent.metrics.viewport),
            typeSize: String(describing: typeSize),
            density: densityId,
            disclosures: shown.disclosures.opens)
    }
    func applyLayoutRevision() {
        let next = currentRevision()
        let changed = next != extent.revision
        if changed { anchor.layoutChanged() }
        extent.applyRevision(next)
        // Rows measure again only when their height changes, so the ones on screen carry what
        // they measured into the new layout; a row the change resizes reports its new height.
        if changed { for (id, height) in anchor.keeper.frames.heights { extent.measure(id, height: Double(height)) } }
        if viewport.layoutChanged(to: next), pinned, !intent.active {
            // Following stays pinned through rotation/split/text-size changes.
        }
    }
    /// Save where the reader was above this view's lifetime: the per-model
    /// session store outlives navigation and compact/regular replacement.
    /// `ClientModel.transcriptSessions` owns it (per connection/machine scope,
    /// no module singleton); the feed only reads and writes through the model.
    func saveSession() {
        guard reading.thread != nil || !following else { return }
        let rows = TranscriptFeedRow.rows(shown)
        let anchor: TranscriptHeldAnchor?
        if let held = viewport.held { anchor = held }
        else if let top = currentTopRow() {
            anchor = TranscriptHeldAnchor(rowID: top.rowID, itemID: top.itemID, top: top.top)
        } else { anchor = nil }
        let session = TranscriptReadingSession(
            threadID: thread.id,
            machineID: model.hostId,
            mode: following ? .following : (viewport.mode == .anchoring ? .anchoring : .reading),
            anchor: anchor,
            lastKey: rows.last?.id,
            paged: reading.paged,
            updatedAt: model.now())
        model.transcriptSessions.save(session)
    }
    /// Restore once the thread's rows are ready. A saved history position
    /// reopens around the saved item identity even when that row is not in the
    /// current live tail; new arrivals since never discard the position. The
    /// saved pixel offset installs into the viewport and is restored after the
    /// rebuilt rows measure (within tolerance), not as a center jump.
    func restoreSessionIfReady() {
        guard thread.loaded, !sessionRestored else { return }
        sessionRestored = true
        guard let saved = model.transcriptSessions.restorable(threadID: thread.id, machineID: model.hostId),
            let anchor = saved.anchor else { setFollowing(true); return }
        setFollowing(false)
        viewport.noteSessionAnchor(anchor)
        let rows = TranscriptFeedRow.rows(shown)
        if rows.contains(where: { $0.id == anchor.rowID }) {
            // The anchor row is on screen: reopen the window around it when
            // this fresh feed has none yet.
            if reading.thread == nil {
                if let item = anchor.itemID ?? rows.first(where: { $0.id == anchor.rowID })?.block.row.items.first {
                    reading.reopen(around: item, model: model, live: thread)
                }
            }
        } else if let item = anchor.itemID {
            // Saved row outside the live tail (paged history, or the tail moved
            // on): rebuild the window around the saved item identity.
            reading.reopen(around: item, model: model, live: thread)
        } else if reading.thread == nil {
            reading.retry(model: model, live: thread)
        }
    }
    /// Explicit extent update with semantic evidence, after the reading rows
    /// commit. The bridge's per-read eviction lists are consumed once, so a
    /// previous list can never mask a later canonical delete. Streaming
    /// changes with no fresh list classify through the bounded removal log: a
    /// missing block whose items all left as `evicted` retains space, and
    /// every other missing block (deleted, regrouped, ambiguous) drops.
    func updateExtent(rows: [TranscriptFeedRow]) {
        let ids = rows.map(\.id)
        if reading.thread == nil {
            // Live tail: no retained space; streaming regroups and deletes drop.
            extent.update(change: TranscriptExtent.WindowChange(ids: ids, movement: .replace))
            anchor.lastBlockItems = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0.block.row.items) })
            return
        }
        let movement: TranscriptExtent.Movement
        if reading.operation == "item" || reading.operation == "turn" { movement = .replace }
        else { movement = reading.operation == "older" ? .older : .newer }
        if movement == .replace {
            extent.update(change: TranscriptExtent.WindowChange(ids: ids, movement: .replace))
            anchor.lastBlockItems = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0.block.row.items) })
            return
        }
        let fresh = reading.hasFreshWindowEvidence
        let evidence = reading.takeWindowEvidence()
        var evicted = Set<String>()
        if fresh {
            evicted.formUnion(prefixedBlocks(evidence.evictedLeading))
            evicted.formUnion(prefixedBlocks(evidence.evictedTrailing))
        }
        let removalByID = Dictionary(uniqueKeysWithValues: shown.recentRemovals.map { ($0.id, $0) })
        let resident = Set(ids)
        for (blockID, items) in anchor.lastBlockItems where !resident.contains(blockID) {
            guard !items.isEmpty else { continue }
            var allEvicted = true
            for item in items {
                guard let removal = removalByID[item], removal.reason == "evicted" else { allEvicted = false; break }
            }
            if allEvicted { evicted.insert(blockID) }
        }
        extent.update(change: TranscriptExtent.WindowChange(
            ids: ids, movement: movement,
            evicted: Array(evicted),
            deleted: prefixedBlocks(evidence.deleted),
            beforeSeq: evidence.beforeSeq, afterSeq: evidence.afterSeq,
            beforeCount: evidence.beforeCount, afterCount: evidence.afterCount,
            spans: evidence.blockSeqs))
        anchor.lastBlockItems = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0.block.row.items) })
    }

    /// Tells the bridge the reader left the end or came back to it, when that changed
    /// (`TranscriptEndRead`), never on each turn of a gesture near the end.
    func endRead(moving: Bool) {
        // Wherever a landing focus's scroll passes, the reader isn't there yet.
        guard !reading.landing.holdsPlace else { return }
        let facts = TranscriptEndRead.Facts(
            fromEnd: Double(intent.metrics.bottom), viewport: Double(intent.metrics.viewport),
            moving: moving, windowOpen: reading.thread != nil, joined: reading.joined,
            followsEnd: reading.followsEnd, loading: reading.loading,
            atEndSlack: Double(AceDesign.Space.group))
        switch TranscriptEndRead.decide(facts) {
        case .hold: reading.read("hold", model: model, live: thread, anchorItemId: currentAnchorItemID())
        case .follow: reading.read("follow", model: model, live: thread, anchorItemId: currentAnchorItemID())
        case .none: break
        }
    }

    /// Approach the loaded edge with a page already in flight. A gesture that reached the older
    /// edge can still request its page at rest if another read was settling during the fling.
    func pageIfNeeded(_ proxy: TranscriptSurface) {
        guard thread.loaded, !reading.loading, model.readingSettled, reading.problem == nil,
              !reading.landing.holdsPlace, intent.metrics.viewport > 0 else { return }
        let needsNewer = extent.needsNewerContent(bottom: intent.metrics.bottom)
        let reachedOlder = !intent.animating && intent.direction < 0 && intent.metrics.top <= 1
        guard needsNewer || (!intent.consumed && (intent.active || reachedOlder)) else { return }
        let edge = extent.edge(top: intent.metrics.top, bottom: intent.metrics.bottom,
                               viewport: intent.metrics.viewport, minimumAhead: AceDesign.Size.tap,
                               direction: intent.direction, flingReach: intent.flingReach)
        if edge == .older, reading.thread == nil ? thread.screen.hasOlder : reading.hasOlder {
            intent.consumed = true
            reading.read("older", model: model, live: thread, anchorItemId: currentAnchorItemID())
        } else if edge == .newer, reading.thread != nil {
            intent.consumed = true
            // A joined window has nothing newer to read: following it again is the rest
            // handler's call (`endRead`), once the reader stops at the end.
            if reading.joined { intent.consumed = false }
            else if reading.hasNewer { reading.read("newer", model: model, live: thread, anchorItemId: currentAnchorItemID()) }
            else { intent.consumed = false }
        }
    }
}
