import SwiftUI

/// Gesture intent is consumed once per page; layout changes and programmatic scrolls never page.
/// Follow mode and scroll direction live in the viewport controller; intent
/// tracks only the in-flight gesture and paging consumption.
private final class TranscriptScrollIntent {
    var active = false
    var consumed = false
    /// The person opened something in place: the next change of height is theirs, not the end's.
    var opened = false
    var metrics = Metrics(y: 0, top: 0, bottom: 0, viewport: 0, topInset: 0, bottomInset: 0, height: 0)
    struct Metrics: Equatable {
        let y: CGFloat; let top: CGFloat; let bottom: CGFloat; let viewport: CGFloat; let topInset: CGFloat; let bottomInset: CGFloat; let height: CGFloat
        /// How far the end the feed can reach is below the bottom edge: negative only when the
        /// feed sits past it. A feed shorter than the screen starts at its top, which is its end.
        var toEnd: CGFloat { max(height + bottomInset - viewport, -topInset) - y }
    }
    /// The feed's own animated scroll is still moving.
    var animating = false
    func begin() { active = true; consumed = false }
}

/// One lazy reading column. Edge scrolling avoids List's stale collection-index scroll targets.
///
/// Every scroll the feed makes is a one-shot `ScrollViewProxy` call. A `ScrollPosition` binding
/// keeps its last target (an edge, an offset or a row) standing until the person scrolls; with an
/// accessibility client attached (VoiceOver, Voice Control, UI automation), a drag against that
/// standing target re-places the lazy rows on every update and pins the main thread.
struct ConversationFeed: View {
    @Environment(\.aceReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.aceDensityId) private var densityId
    let model: ClientModel
    let thread: ThreadModel
    let acceptedSend: Int
    let links: TranscriptLinks
    /// The composer and its strip, floating over the feed's bottom edge.
    var barHeight: CGFloat = 0
    /// The person reads away from the live end; the composer's floaters offer Scroll to end.
    @Binding var behind: Bool
    /// Bumped by each Scroll to end the person taps.
    var jumps = 0
    /// Words taken back from a message that wasn't sent go into the composer.
    @State private var reading = TranscriptReading()
    @State private var initialScroll = false
    @State private var sessionRestored = false
    @State private var intent = TranscriptScrollIntent()
    @State private var settle = TranscriptEndSettle()
    @State private var anchor = TranscriptReadingAnchor()
    @State private var extent = TranscriptExtent()
    @State private var viewport = TranscriptViewportController()
    /// Set when a gesture ends while reading: the next measured layout
    /// refreshes the capture, since frames at idle may predate the final
    /// layout pass. Cleared on first use; session restores own their target.
    @State private var needsPostGestureCapture = false
    /// Previous resident block-to-items snapshot, for classifying missing
    /// blocks on streaming changes without a fresh service reply.
    @State private var lastBlockItems: [String: [String]] = [:]
    /// How far the keyboard reaches above the feed's bottom edge.
    @State private var keyboardLift: CGFloat = 0
    /// While the keyboard moves, the live tail doesn't jump to the end on each delta: the
    /// keyboard's own animation carries the rows there.
    @State private var keyboardMoving = false
    /// The keyboard's last animation duration: the composer opens on the same spring as it.
    @State private var keyboardDuration = 0.35
    @State private var feedBottom: CGFloat = 0
    @State private var feedFrame: CGRect = .zero
    private var shown: ThreadModel { reading.shown ?? thread }
    private var ready: Bool { thread.loaded }
    /// The viewport controller owns the follow mode; the feed never keeps its
    /// own copy. All transitions go through `setFollowing`, which also captures
    /// the semantic anchor when leaving the end.
    private var following: Bool { viewport.mode == .following }
    private func setFollowing(_ value: Bool) {
        if value {
            viewport.goLive()
        } else {
            if let top = currentTopRow() {
                viewport.noteCaptured(rowID: top.rowID, itemID: top.itemID, top: top.top)
            }
            viewport.userLeftEnd()
        }
    }
    private var pinned: Bool { following && (reading.thread == nil || reading.joined) }
    /// History rows are stale disk cache when the bridge said `.cached`, or
    /// whenever the history window is open while offline. Offline can happen
    /// with no new read reply, so connectivity derives stale too. The live
    /// tail stays enabled: only the open history window reads stale.
    private var historyStale: Bool {
        reading.isStale || (reading.thread != nil && model.connection != "ready")
    }

    var body: some View {
        ScrollViewReader { proxy in feed(proxy) }
    }

    private func feed(_ proxy: ScrollViewProxy) -> some View {
        let scroller = ScrollView {
            LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                if let problem = reading.problem {
                    ServiceProblem(message: problem)
                    Button("Retry loading messages") { reading.retry(model: model, live: thread) }
                        .frame(minHeight: AceTheme.Dimensions.touchTarget)
                }
                if ready {
                    if historyStale {
                        // Cached history is explicitly stale and read-only: a
                        // visible indication with retry that never blocks scroll
                        // or the composer. Rows below are disabled.
                        HStack(spacing: AceTheme.Spacing.sm) {
                            Text(reading.isStale ? "Cached history" : "Offline — cached history")
                                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                                .foregroundStyle(AceTheme.Colours.subtleForeground)
                                .accessibilityLabel("Cached history")
                            Spacer()
                            Button("Retry") { retryHistory() }
                                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                                .disabled(reading.loading)
                                .accessibilityIdentifier("transcript.cached.retry")
                        }
                        .padding(.horizontal, AceTheme.Spacing.xl)
                        .padding(.vertical, AceTheme.Spacing.xs)
                        .accessibilityElement(children: .combine)
                        .accessibilityHint("Shows saved history until the thread reconnects")
                    }
                    Color.clear.frame(height: extent.before).accessibilityHidden(true)
                    ForEach(TranscriptFeedRow.rows(shown)) { row in
                        TranscriptFeedRowView(row: row, thread: shown, links: links).id(row.id)
                            .disabled(historyStale)
                            .onAppear { ThreadOpenTrace.shared.painted(thread.id) }
                            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("transcript.viewport")) } action: { frame in
                                anchor.frames[row.id] = frame
                                extent.measure(row.id, height: Double(frame.height))
                                // Post-gesture shell: refresh the capture from settled
                                // frames before any drift correction, so a stale
                                // pre-gesture target can never pull the reader back.
                                // Post-geometry shell: a pending session restore
                                // re-runs after the row actually measures, since
                                // revision events land before lazy remeasurement.
                                if needsPostGestureCapture, viewport.mode == .reading,
                                    !viewport.isAiming, viewport.sessionAnchor == nil {
                                    needsPostGestureCapture = false
                                    if let top = currentTopRow() {
                                        viewport.noteCaptured(rowID: top.rowID, itemID: top.itemID, top: top.top)
                                    }
                                }
                                if viewport.sessionAnchor?.rowID == row.id {
                                    applySessionRestore(proxy: proxy)
                                } else {
                                    correctHeldRowDrift(rowID: row.id, proxy: proxy)
                                }
                            }
                            .onDisappear { anchor.frames[row.id] = nil }
                    }
                    Color.clear.frame(height: extent.after).accessibilityHidden(true)
                } else { ConversationSkeleton().padding(AceTheme.Spacing.xl) }
                if reading.thread == nil || reading.joined {
                    ForEach(model.pending.values.filter { $0.threadId == thread.id && $0.state != "delivered" && thread.items["input:\($0.id)"] == nil }.sorted { $0.id < $1.id }) { row in
                        PendingSendRow(row: row, canRetry: model.canOperate, retry: { await model.retrySend(row) },
                                       words: { await model.sendWords(row.id) },
                                       saveWords: { await model.editFailedSend(row.id, text: $0) },
                                       discard: { await model.dismissSend(row.id) })
                            .padding(.horizontal, AceTheme.Spacing.xl).padding(.vertical, AceTheme.Spacing.xs + AceTheme.Spacing.xxs)
                    }
                    if let held = thread.screen.queue?.notSent {
                        HeldSendRow(message: held, canAct: model.canOperate, act: { await model.actOnQueue($0) },
                                    edit: { message, change in await model.editQueued(message, change: change) },
                                    words: { await model.queuedWords(held.id) },
                                    saveWords: { await model.editQueuedWords(held.id, text: $0, revision: $1) })
                            .padding(.horizontal, AceTheme.Spacing.xl).padding(.vertical, AceTheme.Spacing.xs + AceTheme.Spacing.xxs)
                            .transition(.opacity)
                    }
                }
                // Room for the composer, its strip and the keyboard, and under the last row so it
                // clears the strip tucked above the composer. The feed itself never changes size as
                // they move: resizing a long lazy transcript re-estimates its height and throws the
                // scroll offset, so only this row grows and shrinks.
                Color.clear.frame(height: barHeight + keyboardLift + AceTheme.Spacing.xxl).accessibilityHidden(true)
                // The end of the feed: scrolling to it puts the room above at the bottom.
                TranscriptTail(thread: thread, following: pinned) { if !keyboardMoving && !intent.active { toEnd(proxy) } }
            }
            .modifier(TranscriptTextSize())
            .padding(.top, AceTheme.Spacing.sm)
            // A message that wasn't sent fades in and out where it was written.
            .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth, value: thread.screen.queue?.notSent?.id)
            // A comfortable line on a wide window; the scroll itself stays full width.
            .frame(maxWidth: ReadingColumn.maxWidth)
            .frame(maxWidth: .infinity)
        }
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { feedFrame = $0; feedBottom = $0.maxY }
        .coordinateSpace(name: "transcript.viewport")
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .background(AceTheme.Colours.background)
        .overlay(alignment: .top) {
            if reading.loading, reading.operation == "older" || reading.operation == "newer" {
                AceShape.capsule.fill(AceTheme.Colours.fill).frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Spacing.sm)
                    .padding(AceTheme.Spacing.lg).allowsHitTesting(false)
                    .accessibilityLabel("Loading messages").accessibilityIdentifier("transcript.paging")
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .modifier(TapPutsKeyboardAway(up: keyboardLift > 0))
        // ⇧⌥⌘↑ and ↓ on a hardware keyboard, as on the web: the turn before and after the one on
        // top. They repeat the thread menu's Turns list, never the only way.
        .background { TurnKeys { stepTurn($0, proxy: proxy) } }
        .accessibilityIdentifier("transcript")
        .accessibilityValue(ready ? (historyStale ? "Cached history" : reading.paged ? "Reading history" : "Ready") : "Loading")
        .onScrollPhaseChange { old, phase in
            switch phase {
            case .tracking:
                settle.cancel()
                viewport.cancelPending()
                model.beginReadingScroll()
                intent.begin()
            // A quick drag can skip tracking: a new gesture is one that starts from rest.
            case .interacting where old == .idle || old == .decelerating || old == .animating:
                settle.cancel()
                viewport.cancelPending()
                model.beginReadingScroll()
                intent.begin(); intent.active = true
            case .interacting, .decelerating: intent.active = true
            case .idle:
                // Only the person's own scroll decides whether the feed follows the end; the
                // feed's animated scrolls (the keyboard, the composer) settle while text streams.
                let touched = intent.active
                intent.active = false
                model.endReadingScroll()
                if touched {
                    let atEnd = intent.metrics.bottom <= AceTheme.Spacing.xxl
                    let live = reading.thread == nil || reading.joined
                    setFollowing(atEnd && live)
                    // The idle-time capture may predate the final layout pass;
                    // refresh it on the next measured geometry so a stale
                    // pre-gesture target can never pull the reader back.
                    needsPostGestureCapture = viewport.mode != .following
                }
                pageIfNeeded(proxy)
            case .animating: break
            @unknown default: break
            }
            intent.animating = phase == .animating
        }
        .onScrollGeometryChange(for: TranscriptScrollIntent.Metrics.self) { geometry in
            // The container is the area inside the insets; the feed runs under the header and
            // the home indicator, so its frame is the container with both insets around it.
            let insets = geometry.contentInsets
            let frame = geometry.containerSize.height + insets.top + insets.bottom
            return TranscriptScrollIntent.Metrics(y: geometry.contentOffset.y,
                top: geometry.contentOffset.y + insets.top,
                bottom: geometry.contentSize.height + insets.bottom - geometry.contentOffset.y - frame,
                viewport: frame, topInset: insets.top, bottomInset: insets.bottom, height: geometry.contentSize.height)
        } action: { old, new in
            intent.metrics = new
            if intent.opened, new.height != old.height {
                // What opened grows under the row the person tapped, which stays put; the feed
                // follows the end again only if the end is still in view.
                intent.opened = false
                if reading.thread == nil { setFollowing(new.bottom <= AceTheme.Spacing.xxl) }
            }
            // Geometry is an observation, not a new scroll request. The bounded correction
            // already handles lazy-row remeasurement after a content or composer change.
            if thread.loaded, new.bottom <= 1 { ThreadOpenTrace.shared.settled(thread.id) }
            if intent.active {
                // Hold the rows as soon as the person leaves the live end, before streaming
                // can trim the messages they are reading out of the tail.
                if new.y < old.y - 1 {
                    viewport.noteDirection(-1)
                    if following, !reading.loading { reading.read("hold", model: model, live: thread, anchorItemId: currentAnchorItemID()) }
                    setFollowing(false)
                }
                else if new.y > old.y + 1 { viewport.noteDirection(1) }
                pageIfNeeded(proxy)
            }
        }
        return observeReading(scroller, proxy: proxy)
    }

    private func observeReading<Content: View>(_ content: Content, proxy: ScrollViewProxy) -> some View {
        content.onChange(of: acceptedSend) { _, _ in
            reading.live(model: model, thread: thread)
            setFollowing(true)
            toEnd(proxy)
        }
        .onChange(of: shown.disclosures.opens) { _, _ in
            intent.opened = true
            // Anchor the disclosure while reading history; the live end keeps following.
            if !following || reading.thread != nil, let top = currentTopRow() {
                viewport.toggle(rowID: top.rowID, itemID: top.itemID, top: top.top)
            }
            applyLayoutRevision()
        }
        .onChange(of: shown.screen.blockOrder, initial: true) { _, _ in updateExtent() }
        .onChange(of: reading.thread?.epoch) { _, _ in
            extent.update(change: TranscriptExtent.WindowChange(
                ids: shown.screen.blockOrder.map { "block:\($0)" }, movement: .replace))
            lastBlockItems = Dictionary(uniqueKeysWithValues:
                TranscriptFeedRow.rows(shown).map { ($0.id, $0.block.row.items) })
        }
        .onChange(of: reading.loading) { _, loading in if !loading { pageIfNeeded(proxy) } }
        .onChange(of: reading.revision) { _, _ in
            guard reading.thread != nil else { return }
            if UIAccessibility.isVoiceOverRunning { viewport.clearSessionAnchor() }
            updateExtent()
            let rows = TranscriptFeedRow.rows(shown)
                if let session = viewport.sessionAnchor, rows.contains(where: { $0.id == session.rowID }) {
                    // Session restore owns this pass: a center jump would lose
                    // the saved pixel offset. Coarse-scroll until the row
                    // measures, then refine to the exact offset below.
                    reading.focus = nil
                    if anchor.frames[session.rowID] == nil {
                        if viewport.correctionFrames == 0 {
                            proxy.scrollTo(session.rowID, anchor: .center)
                        }
                        viewport.noteCorrectionApplied()
                    } else {
                        applySessionRestore(proxy: proxy)
                    }
                } else if let focus = reading.focus, let row = reading.thread?.screen.blockOrder.first(where: { reading.thread?.screen.blocks[$0]?.row.items.contains(focus) == true }) {
                reading.focus = nil
                proxy.scrollTo("block:\(row)", anchor: .center)
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
                    }
                case .aim(let index):
                    if rows.indices.contains(index) { proxy.scrollTo(rows[index].id, anchor: .center) }
                case .end, .none: break
                }
            }
            pageIfNeeded(proxy)
        }
        .onChange(of: model.focusOnOpen, initial: true) { _, _ in focusRequested() }
        .onChange(of: thread.loaded) { _, loaded in
            guard loaded else { focusRequested(); return }
            restoreSessionIfReady()
            if !initialScroll {
                if following { toEnd(proxy) }
                initialScroll = true
            }
            focusRequested()
        }
        .onChange(of: typeSize) { _, _ in applyLayoutRevision() }
        .onChange(of: densityId) { _, _ in applyLayoutRevision() }
        .onChange(of: feedFrame.size) { _, _ in
            // Rotation and split-view width changes invalidate measurements
            // automatically: only geometry (not paging or streaming) does.
            applyLayoutRevision()
        }
        .onChange(of: model.connection) { _, connection in
            // A fresh complete window on reconnect before clearing stale: the
            // bridge resets its stale window and loads around the anchor item,
            // so never merge old cached chunks with new authoritative rows.
            if connection == "ready", reading.thread != nil, !reading.loading {
                reading.refreshAfterReconnect(model: model, live: thread, anchorItemId: currentAnchorItemID())
            }
        }
        .task {
            model.readingWillMove = {
                if let top = currentTopRow() {
                    viewport.noteCaptured(rowID: top.rowID, itemID: top.itemID, top: top.top)
                }
            }
            model.readingMoved = { reading.moved() }
            // Overflow recovery hook: fired once after the gesture ends (or the
            // page settles) when the held queue discarded rows with no fresh
            // reset yet. Rebuilds authoritatively around the saved item anchor;
            // old rows stay readable until the replacement publishes, and the
            // hold clears `needsFresh` only on that fresh flush. Captures only
            // class-backed state so the closure never goes stale.
            model.onReadingNeedsFresh = { [anchor, intent, reading, thread, model] in
                guard reading.thread != nil, !reading.loading else { return }
                let shown = reading.shown ?? thread
                let rows = TranscriptFeedRow.rows(shown)
                let top = intent.metrics.topInset
                let item = rows.filter({ (anchor.frames[$0.id]?.maxY ?? -.infinity) > top + 1 })
                    .min(by: { (anchor.frames[$0.id]?.minY ?? .infinity) < (anchor.frames[$1.id]?.minY ?? .infinity) })?.block.row.items.first
                    ?? reading.lastAnchorItemId
                if let item { reading.rebuild(model: model, live: thread, anchorItemId: item) }
            }
            restoreSessionIfReady()
            applyLayoutRevision()
            if thread.loaded, !initialScroll {
                if following { toEnd(proxy) }
                initialScroll = true
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            guard let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
            let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
            // Intersection, not just vertical overlap: a floating keyboard
            // beside the reading column reserves no space over it.
            let lift: CGFloat
            if feedFrame == .zero {
                lift = max(0, feedBottom - end.minY)
            } else {
                lift = CGFloat(TranscriptKeyboardLift.overlap(
                    feedMinX: Double(feedFrame.minX), feedMaxX: Double(feedFrame.maxX), feedBottom: Double(feedBottom),
                    keyboardMinX: Double(end.minX), keyboardMaxX: Double(end.maxX), keyboardMinY: Double(end.minY)))
            }
            if duration > 0 { keyboardDuration = duration }
            guard lift != keyboardLift else { return }
            let motion: Animation? = reduceMotion ? nil : .spring(duration: duration, bounce: 0)
            let growth = lift - keyboardLift
            keyboardMoving = true
            // The room is empty space: it changes at once, and only the scroll animates, so the
            // two never drift apart on different curves.
            var instant = Transaction()
            instant.disablesAnimations = true
            withTransaction(instant) { keyboardLift = lift }
            roomChanged(by: growth, motion: motion, proxy: proxy)
        }
        .onChange(of: barHeight) { old, new in
            // The composer opening as it takes the keyboard moves on the keyboard's spring.
            let motion = keyboardMoving ? Animation.spring(duration: keyboardDuration, bounce: 0) : AceTheme.Motion.standardCurve
            roomChanged(by: new - old, motion: reduceMotion ? nil : motion, proxy: proxy)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidChangeFrameNotification)) { _ in
            keyboardMoving = false
            // Text that streamed in while the keyboard moved.
            if pinned && !intent.active { toEnd(proxy) }
        }
        .onDisappear {
            settle.cancel()
            saveSession()
            reading.cancel(model: model)
            model.readingWillMove = nil
            model.readingMoved = nil
            model.onReadingNeedsFresh = nil
        }
        .onChange(of: !following || reading.thread != nil, initial: true) { _, away in if behind != away { behind = away } }
        .onChange(of: jumps) { _, _ in
            reading.live(model: model, thread: thread)
            setFollowing(true)
            toEnd(proxy)
        }
        .modifier(TranscriptTopEdge())
    }
    /// The room at the end changed (the keyboard, the composer or its strip). Following the end,
    /// the last row moves with it, in the same motion; reading elsewhere, the rows stay put and
    /// are covered, unless the smaller room would park the view past the end.
    private func roomChanged(by growth: CGFloat, motion: Animation?, proxy: ScrollViewProxy) {
        guard !intent.active, growth != 0, pinned || intent.metrics.bottom + growth < 0 else { return }
        // The room has its new height in this same update, so the end is where the scroll lands,
        // starting in the same frame as the keyboard.
        settle.cancel()
        withAnimation(motion) { toEnd(proxy) }
    }
    private func toEnd(_ proxy: ScrollViewProxy) {
        guard !settle.isRunning else { return }
        proxy.scrollTo(TranscriptTail.id, anchor: .bottom)
        let intent = intent
        guard !UIAccessibility.isVoiceOverRunning else { return }
        settle.run(gap: { pinned && !intent.active && !keyboardMoving ? intent.metrics.toEnd : nil },
                   wait: { intent.animating }) { proxy.scrollTo(TranscriptTail.id, anchor: .bottom) }
    }
    /// The previous or next turn from the one at the top of the screen: its ask scrolls to the
    /// top. Past the rows held, an earlier turn pages older history in; after the last, the end.
    private func stepTurn(_ direction: Int, proxy: ScrollViewProxy) {
        let rows = TranscriptFeedRow.rows(shown)
        let starts = rows.indices.filter { rows[$0].block.row.kind == "user" }
        let top = intent.metrics.topInset
        let first = rows.firstIndex { (anchor.frames[$0.id]?.maxY ?? -.infinity) > top + 1 } ?? rows.count - 1
        setFollowing(false)
        if direction > 0 {
            if let next = starts.first(where: { $0 > first }) { withAnimation { proxy.scrollTo(rows[next].id, anchor: .top) }; return }
            reading.live(model: model, thread: thread); setFollowing(true); toEnd(proxy)
            return
        }
        let here = starts.last { $0 <= first }
        let sitsBelow = here.map { (anchor.frames[rows[$0].id]?.minY ?? top) < top - AceTheme.Spacing.sm } ?? false
        if let here, here < first || sitsBelow { withAnimation { proxy.scrollTo(rows[here].id, anchor: .top) }; return }
        if let previous = starts.last(where: { $0 < (here ?? first) }) { withAnimation { proxy.scrollTo(rows[previous].id, anchor: .top) }; return }
        if reading.thread == nil ? thread.screen.hasOlder : reading.hasOlder { reading.read("older", model: model, live: thread, anchorItemId: currentAnchorItemID()) }
    }
    /// A search hit asked for an item in this thread: the shared window opens around it.
    private func focusRequested() {
        guard thread.loaded, let focus = model.focusOnOpen, focus.thread == thread.id else { return }
        model.focusOnOpen = nil
        setFollowing(false)
        if let turn = focus.turn { reading.jump(toTurn: turn, model: model, live: thread) }
        else { reading.jump(to: focus.item, model: model, live: thread) }
    }
    /// Retry stale history: re-ask the bridge around the reader's anchor item
    /// so the rebuild loads fresh rows instead of merging cached chunks.
    private func retryHistory() {
        if historyStale {
            reading.refreshAfterReconnect(model: model, live: thread, anchorItemId: currentAnchorItemID())
            if !reading.loading, reading.thread == nil { reading.retry(model: model, live: thread) }
        } else {
            reading.retry(model: model, live: thread)
        }
    }
    /// Refine a pending session restore to its saved pixel offset once the row
    /// has measured. No-ops (keeping the restore pending) until the frame
    /// arrives; clears once the frame settles within tolerance, and the
    /// viewport budget (or a gesture) cancels a restore that never settles.
    private func applySessionRestore(proxy: ScrollViewProxy) {
        guard let session = viewport.sessionAnchor,
            let frame = anchor.frames[session.rowID] else { return }
        let metrics = intent.metrics
        let top = Double(frame.minY) - Double(metrics.topInset)
        if abs(top - session.top) <= 2 {
            viewport.clearSessionAnchor()
            return
        }
        if let fraction = viewport.sessionRestoreFraction(
            viewport: Double(metrics.viewport),
            topInset: Double(metrics.topInset), bottomInset: Double(metrics.bottomInset),
            rowHeight: Double(frame.height)) {
            proxy.scrollTo(session.rowID, anchor: UnitPoint(x: 0, y: fraction))
        } else {
            proxy.scrollTo(session.rowID, anchor: .top)
        }
        viewport.noteCorrectionApplied()
    }
    /// The reader's semantic anchor item: the first item of the topmost visible
    /// row, falling back to the viewport's captured anchor.
    private func currentAnchorItemID() -> String? {
        currentTopRow()?.itemID ?? viewport.held?.itemID
    }
    /// The topmost visible row with its first item and pixel top, for anchor
    /// capture, successor search and session restore.
    private func currentTopRow() -> (rowID: String, itemID: String?, top: Double)? {
        let top = intent.metrics.topInset
        let rows = TranscriptFeedRow.rows(shown)
        guard let first = rows.filter({ (anchor.frames[$0.id]?.maxY ?? -.infinity) > top + 1 })
            .min(by: { (anchor.frames[$0.id]?.minY ?? .infinity) < (anchor.frames[$1.id]?.minY ?? .infinity) }) else { return nil }
        return (rowID: first.id, itemID: first.block.row.items.first,
                top: Double((anchor.frames[first.id]?.minY ?? top) - top))
    }
    /// A row's pixel top in viewport coordinates, for the viewport controller.
    private func rowTop(_ rowID: String) -> Double {
        Double((anchor.frames[rowID]?.minY ?? intent.metrics.topInset) - intent.metrics.topInset)
    }
    /// Scroll so `rowID` sits `top` points below the viewport top. Returns
    /// false when the row fills the viewport (caller falls back to top
    /// alignment). Fraction math keeps partial rows as well as top-aligned
    /// ones, like the capture/restore fraction.
    @discardableResult
    private func placeRowAtTop(_ rowID: String, top: Double, proxy: ScrollViewProxy) -> Bool {
        guard let frame = anchor.frames[rowID] else { return false }
        let metrics = intent.metrics
        guard let fraction = TranscriptAnchorPlacement.fraction(top: top,
            viewport: Double(metrics.viewport), topInset: Double(metrics.topInset),
            bottomInset: Double(metrics.bottomInset), rowHeight: Double(frame.height)) else { return false }
        proxy.scrollTo(rowID, anchor: UnitPoint(x: 0, y: fraction))
        return true
    }
    /// Pure-geometry drift of the ordinary held row: async Markdown/media
    /// sizing can move it with no bridge patch and no revision event. Bounded
    /// by the viewport budget, cancelled by gestures, and never fights an
    /// active drag, a landing jump, VoiceOver, or the live end.
    private func correctHeldRowDrift(rowID: String, proxy: ScrollViewProxy) {
        guard !intent.active, !viewport.isAiming, viewport.canCorrect,
            !UIAccessibility.isVoiceOverRunning,
            viewport.mode != .following,
            let held = viewport.held, held.rowID == rowID,
            anchor.frames[rowID] != nil else { return }
        let frame = anchor.frames[rowID]!
        let drift = Double(frame.minY) - Double(intent.metrics.topInset) - held.top
        guard abs(drift) > 2 else { return }
        if !placeRowAtTop(rowID, top: held.top, proxy: proxy) {
            proxy.scrollTo(rowID, anchor: .top)
        }
        viewport.noteCorrectionApplied()
    }
    /// Item-level successor for a gone held row: the row holding the smallest
    /// creation sequence past the removed item's, from the bounded removal log.
    /// Nil falls back to the controller's positional successor scan.
    private func itemSuccessor(for goneRowID: String, rows: [TranscriptFeedRow]) -> (key: String, index: Int, top: Double)? {
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
    private func prefixedBlock(_ raw: String) -> String {
        raw.hasPrefix("block:") ? raw : "block:\(raw)"
    }
    private func prefixedBlocks(_ raw: [String]?) -> [String] {
        (raw ?? []).map(prefixedBlock)
    }
    private func currentRevision() -> TranscriptLayoutRevision {
        TranscriptLayoutRevision.current(
            width: Double(feedFrame.width > 0 ? feedFrame.width : intent.metrics.viewport),
            height: Double(intent.metrics.viewport),
            typeSize: String(describing: typeSize),
            density: densityId,
            disclosures: shown.disclosures.opens)
    }
    private func applyLayoutRevision() {
        let next = currentRevision()
        extent.applyRevision(next)
        if viewport.layoutChanged(to: next), pinned, !intent.active {
            // Following stays pinned through rotation/split/text-size changes.
        }
    }
    /// Save where the reader was above this view's lifetime: the per-model
    /// session store outlives navigation and compact/regular replacement.
    /// `ClientModel.transcriptSessions` owns it (per connection/machine scope,
    /// no module singleton); the feed only reads and writes through the model.
    private func saveSession() {
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
    private func restoreSessionIfReady() {
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
                    reading.jump(to: item, model: model, live: thread)
                }
            }
        } else if let item = anchor.itemID {
            // Saved row outside the live tail (paged history, or the tail moved
            // on): rebuild the window around the saved item identity.
            reading.jump(to: item, model: model, live: thread)
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
    private func updateExtent() {
        let rows = TranscriptFeedRow.rows(shown)
        let ids = rows.map(\.id)
        if reading.thread == nil {
            // Live tail: no retained space; streaming regroups and deletes drop.
            extent.update(change: TranscriptExtent.WindowChange(ids: ids, movement: .replace))
            lastBlockItems = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0.block.row.items) })
            return
        }
        let movement: TranscriptExtent.Movement
        if reading.operation == "item" || reading.operation == "turn" { movement = .replace }
        else { movement = reading.operation == "older" ? .older : .newer }
        if movement == .replace {
            extent.update(change: TranscriptExtent.WindowChange(ids: ids, movement: .replace))
            lastBlockItems = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0.block.row.items) })
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
        for (blockID, items) in lastBlockItems where !ids.contains(blockID) {
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
        lastBlockItems = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0.block.row.items) })
    }

    /// Approaching a resident edge loads another page. A fling into retained space keeps
    /// loading after the finger lifts, until real rows cover the viewport again.
    private func pageIfNeeded(_ proxy: ScrollViewProxy) {
        guard thread.loaded, !reading.loading, model.readingSettled, reading.problem == nil else { return }
        let inRetainedSpace = extent.needsContent(top: intent.metrics.top, bottom: intent.metrics.bottom)
        guard inRetainedSpace || (intent.active && !intent.consumed) else { return }
        let ahead = max(AceTheme.Dimensions.touchTarget, intent.metrics.viewport * 1.5)
        let edge = extent.edge(top: intent.metrics.top, bottom: intent.metrics.bottom, ahead: ahead, direction: viewport.direction)
        if edge == .older, reading.thread == nil ? thread.screen.hasOlder : reading.hasOlder {
            intent.consumed = true
            reading.read("older", model: model, live: thread, anchorItemId: currentAnchorItemID())
        } else if edge == .newer, reading.thread != nil {
            intent.consumed = true
            if reading.joined, intent.metrics.bottom <= AceTheme.Spacing.xxl {
                reading.read("follow", model: model, live: thread, anchorItemId: currentAnchorItemID())
                setFollowing(true)
            } else if reading.hasNewer { reading.read("newer", model: model, live: thread, anchorItemId: currentAnchorItemID()) }
            else { intent.consumed = false }
        }
    }
}

/// While the keyboard is up, a tap on the conversation only puts it away: the tap takes priority
/// over the rows' own (a tool group, a step, a link), so it never opens what lay under the finger.
/// Scrolling still dismisses it interactively. With the keyboard down the gesture is off and taps,
/// links, selection and menus reach the rows as usual.
private struct TapPutsKeyboardAway: ViewModifier {
    let up: Bool
    func body(content: Content) -> some View {
        content
            .contentShape(Rectangle())
            .highPriorityGesture(TapGesture().onEnded {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            }, including: up ? .all : .subviews)
    }
}

/// The header over the transcript: on iOS 26 and later the bar draws nothing of its own, and rows
/// fade softly under its buttons as the system's bars do (no band, no hairline). Before, the bar
/// is opaque in the page colour.
private struct TranscriptTopEdge: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            content.toolbarBackground(AceTheme.Colours.background, for: .navigationBar)
                .toolbarBackgroundVisibility(.visible, for: .navigationBar)
        }
    }
}

/// The previous and next turn on a hardware keyboard, listed in the ⌘ overlay by name.
private struct TurnKeys: View {
    let step: (Int) -> Void
    var body: some View {
        VStack {
            Button("Previous turn") { step(-1) }.keyboardShortcut(.upArrow, modifiers: [.shift, .option, .command])
            Button("Next turn") { step(1) }.keyboardShortcut(.downArrow, modifiers: [.shift, .option, .command])
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
