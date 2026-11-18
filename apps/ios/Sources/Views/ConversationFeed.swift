import SwiftUI

/// Rows that re-measured shorter than their estimates (a thread opened at its end, folds
/// closing) shrink the content under a still offset, leaving the feed past its end: an empty
/// screen until a drag bounces it back. Only a feed nobody is moving is put back.
enum TranscriptEnd {
    /// `toEnd`: how far the reachable end is below the bottom edge, negative past it.
    static func stranded(oldHeight: Double, newHeight: Double, toEnd: Double, moving: Bool) -> Bool {
        !moving && newHeight < oldHeight && toEnd < -1
    }
}

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
        static func strandedPastEnd(old: Metrics, new: Metrics, moving: Bool) -> Bool {
            TranscriptEnd.stranded(oldHeight: Double(old.height), newHeight: Double(new.height), toEnd: Double(new.toEnd), moving: moving)
        }
    }
    /// The feed's own animated scroll is still moving.
    var animating = false
    /// An older page was asked for and hasn't joined yet: its rows are held still as they land.
    var olderPage = false
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
    /// How far the keyboard lifts the composer, frame by frame; the rows following the end ride it.
    let keyboard: KeyboardRide
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
    /// Bumped when the rows move to the other stack (`restack`).
    @State private var stackSwitches = 0
    @State private var extent = TranscriptExtent()
    @State private var viewport = TranscriptViewportController()
    /// Previous resident block-to-items snapshot, for classifying missing
    /// blocks on streaming changes without a fresh service reply.
    @State private var lastBlockItems: [String: [String]] = [:]
    /// The room the keyboard takes under the last row (`TranscriptKeyboardRoom`).
    @State private var keyboardRoom = TranscriptKeyboardRoom()
    /// How far the keyboard reaches above the feed's bottom edge.
    private var keyboardLift: CGFloat { CGFloat(keyboardRoom.kept) }
    /// The rows follow the end on the keyboard's ride (`keyboardWillMove`), drawn up by its lift
    /// beyond the lift the scroll already allows for (`TranscriptKeyboardFollow`). Only drawing
    /// moves: rows measure and the scroll reads as if they didn't.
    @State private var keyboardFollow = TranscriptKeyboardFollow()
    /// While the keyboard moves, the live tail doesn't jump to the end on each delta: the
    /// keyboard's ride carries the rows there.
    @State private var keyboardMoving = false
    @State private var feedFrame: CGRect = .zero
    /// The edge that holds still while lazy rows correct their heights (`TranscriptGrowthAnchor`).
    @State private var growth = TranscriptGrowthAnchor()
    /// A row has been drawn since the feed appeared: the opening's hold counts from here.
    @State private var rowsPainted = false
    /// The feed is shown: a thread opening stays hidden until its end has settled (ADR 0157).
    @State private var revealed = false
    /// The scroll view under the rows, for the reveal and an older page's hold (`TranscriptSurface`).
    @State private var surface = TranscriptSurface()
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
            captureTop()
            viewport.userLeftEnd()
            if growth.keepsEnd { growth.leftEnd() }
        }
    }
    /// Size changes keep the bottom still: from the first render of a feed following the end,
    /// before `appeared` has run, and then while the opening's hold lasts.
    private var holdsEnd: Bool { growth.keepsEnd || (!rowsPainted && following) }
    /// The reader moved the feed or changed what it holds: size changes keep the top again.
    private func readerMovedFeed() {
        if growth.keepsEnd { growth.readerMoved() }
        if surface.holding { endPageHold() }
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

    /// The scroll view's own frame, header and home indicator included.
    nonisolated private static let viewportSpace = "transcript.viewport"
    /// The scrolling content: rows keep their frames in it while the feed scrolls.
    nonisolated private static let contentSpace = "transcript.content"

    private func feed(_ proxy: ScrollViewProxy) -> some View {
        // The stack for these rows (ADR 0157): chosen before they first lay out, switched only by
        // `restack`, which bumps `stackSwitches` to lay them out again in the other one.
        let _ = stackSwitches
        let rowCount = TranscriptFeedRow.rows(shown).count
        let stack: TranscriptStackChoice.Stack = ready && rowCount > 0 ? anchor.stack.opened(rows: rowCount) : .lazy
        PerfCounters.bump("feed.body")
        let scroller = ScrollView {
            TranscriptRowsStack(stack: stack) {
                if let problem = reading.problem {
                    ServiceProblem(message: problem)
                    Button("Retry loading messages") { reading.retry(model: model, live: thread) }
                        .frame(minHeight: AceDesign.Size.tap)
                }
                if ready {
                    if historyStale {
                        // Cached history is explicitly stale and read-only: a
                        // visible indication with retry that never blocks scroll
                        // or the composer. Rows below are disabled.
                        HStack(spacing: AceDesign.Space.related) {
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
                        .padding(.horizontal, AceDesign.Space.margin)
                        .padding(.vertical, AceDesign.Space.tight)
                        .accessibilityElement(children: .combine)
                        .accessibilityHint("Shows saved history until the thread reconnects")
                    }
                    Color.clear.frame(height: extent.before).accessibilityHidden(true)
                    ForEach(TranscriptFeedRow.rows(shown)) { row in
                        TranscriptFeedRowView(row: row, thread: shown, links: links).equatable().id(row.id)
                            .transcriptJumpMark(row.id)
                            .disabled(historyStale)
                            .onAppear {
                                ThreadOpenTrace.shared.painted(thread.id); PerfProbe.add("rows.appeared", 1); PerfCounters.bump("row.appear")
                                if !rowsPainted { rowsPainted = true }
                            }
                            // The row's frame in the content, not on screen: a scroll leaves it
                            // alone, so this runs when rows change height, never per scroll frame.
                            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.contentSpace)) } action: { frame in
                                rowLaidOut(row.id, frame: frame, proxy: proxy)
                            }
                            .onDisappear { keep(.gone(row.id), proxy: proxy); PerfCounters.bump("row.disappear") }
                    }
                    Color.clear.frame(height: extent.after).accessibilityHidden(true)
                } else { ConversationSkeleton().padding(AceDesign.Space.margin) }
                if reading.thread == nil || reading.joined {
                    ForEach(model.pending.values.filter { $0.threadId == thread.id && $0.state != "delivered" && thread.items["input:\($0.id)"] == nil }.sorted { $0.id < $1.id }) { row in
                        PendingSendRow(row: row, canRetry: model.canOperate, retry: { await model.retrySend(row) },
                                       words: { await model.sendWords(row.id) },
                                       saveWords: { await model.editFailedSend(row.id, text: $0) },
                                       discard: { await model.dismissSend(row.id) })
                            .padding(.horizontal, AceDesign.Space.margin).padding(.vertical, AceDesign.Space.tight)
                    }
                    // A message that wasn't sent is the strip's above the composer (`NotSentStrip`).
                }
                // A finished turn with changes: one quiet line to review them (`ReviewReadyLine`).
                ReviewReadyLine(model: model)
                // Room for the composer, its strip and the keyboard, and under the last row so it
                // clears the strip tucked above the composer. The feed itself never changes size or
                // insets as they move: resizing a long lazy transcript re-estimates its height and
                // throws the scroll offset, so only this row grows and shrinks.
                Color.clear.frame(height: barHeight + keyboardLift + AceDesign.Space.group).accessibilityHidden(true)
                    .keyboardDriftMark(.line)
                // The end of the feed: scrolling to it puts the room above at the bottom.
                TranscriptTail(thread: thread, following: pinned) { if !keyboardMoving && !intent.active { toEnd(proxy) } }
                // A closing keyboard's room, below the end until the rows have moved down to it.
                Color.clear.frame(height: CGFloat(keyboardRoom.leaving)).accessibilityHidden(true)
            }
            .modifier(TranscriptTextSize())
            .padding(.top, AceDesign.Space.related)
            // A message that wasn't sent fades in and out where it was written.
            .animation(.default, value: thread.screen.queue?.notSent?.id)
            // A comfortable line on a wide window; the scroll itself stays full width.
            .frame(maxWidth: ReadingColumn.maxWidth)
            .frame(maxWidth: .infinity)
            .coordinateSpace(name: Self.contentSpace)
            .background { TranscriptSurfaceReader(surface: surface).accessibilityHidden(true) }
            // Hidden while a thread opens, then shown where it settled (`revealWhenSettled`).
            .opacity(ready && !revealed ? 0 : 1)
            // Outside the rows' space and inside the reader below, so neither sees it.
            .modifier(KeyboardRideOffset(ride: keyboard, base: CGFloat(keyboardFollow.base), riding: keyboardFollow.riding))
            // Where the content's top is on screen: the one number a scroll changes.
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(Self.viewportSpace)).minY } action: { origin in
                contentScrolled(to: origin, proxy: proxy)
            }
        }
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { feedFrame = $0 }
        .coordinateSpace(name: Self.viewportSpace)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        // Rows measuring above the screen don't move it while a thread opens at its end
        // (`TranscriptGrowthAnchor`).
        .defaultScrollAnchor(holdsEnd ? .bottom : nil, for: .sizeChanges)
        // A short thread sits on the dock, not at the top with empty room under it.
        .defaultScrollAnchor(.bottom, for: .alignment)
        .background(AceTheme.Colours.background)
        .overlay(alignment: .top) {
            if reading.loading, reading.operation == "older" || reading.operation == "newer" {
                AceShape.capsule.fill(AceTheme.Colours.fill).frame(width: AceDesign.Size.tap, height: AceDesign.Space.related)
                    .padding(AceDesign.Space.margin).allowsHitTesting(false)
                    .accessibilityLabel("Loading messages").accessibilityIdentifier("transcript.paging")
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .modifier(TapPutsKeyboardAway(up: keyboardLift > 0))
        // ⇧⌥⌘↑ and ↓ on a hardware keyboard, as on the web: the turn before and after the one on
        // top. They repeat the thread menu's Turns list, never the only way.
        .background { TurnKeys { stepTurn($0, proxy: proxy) } }
        .accessibilityIdentifier("transcript")
        .accessibilityValue(ready ? (historyStale ? "Cached history" : reading.paged && !pinned ? "Reading history" : "Ready") : "Loading")
        .onScrollPhaseChange { old, phase in
            switch phase {
            case .tracking:
                readerMovedFeed()
                settle.cancel()
                viewport.cancelPending()
                readerTookOver(proxy)
                model.beginReadingScroll()
                intent.begin()
                keep(.phase(.gesture), proxy: proxy)
            // A quick drag can skip tracking: a new gesture is one that starts from rest.
            case .interacting where old == .idle || old == .decelerating || old == .animating:
                readerMovedFeed()
                settle.cancel()
                viewport.cancelPending()
                readerTookOver(proxy)
                model.beginReadingScroll()
                intent.begin(); intent.active = true
                keep(.phase(.gesture), proxy: proxy)
            case .interacting, .decelerating:
                intent.active = true
                keep(.phase(.gesture), proxy: proxy)
            case .idle:
                // Only the person's own scroll decides whether the feed follows the end; the
                // feed's animated scrolls (the keyboard, the composer) settle while text streams.
                let touched = intent.active
                intent.active = false
                model.endReadingScroll()
                if touched {
                    let atEnd = intent.metrics.bottom <= AceDesign.Space.group
                    let live = reading.thread == nil || reading.joined
                    setFollowing(atEnd && live)
                    endRead(moving: false)
                } else if TranscriptEndButton.leftByOtherScroll(following: pinned, fromEnd: Double(intent.metrics.bottom),
                                                                viewport: Double(intent.metrics.viewport),
                                                                settling: settle.isRunning || keyboardMoving) {
                    // A scroll that wasn't the person's drag (the status bar's tap to the top,
                    // VoiceOver) left the end far behind: stop following, as a drag would.
                    setFollowing(false)
                }
                // An assistive scroll (VoiceOver's three-finger swipe, Switch Control) is the
                // reader's own though no finger tracked it; the feed's own scrolls are excluded.
                if !touched, old == .animating || old == .decelerating, !settle.isRunning, !keyboardMoving,
                   UIAccessibility.isVoiceOverRunning || UIAccessibility.isSwitchControlRunning {
                    readerTookOver(proxy)
                }
                // After the follow mode above: where the scroll came to rest is held, and a
                // correction owed while it ran is made (`TranscriptPlaceKeeper`).
                keep(.phase(.idle), proxy: proxy)
                restack(rows: TranscriptFeedRow.rows(shown).count, moving: false, replaced: false, proxy: proxy)
                updateBehind()
                pageIfNeeded(proxy)
            case .animating:
                keep(.phase(.animating), proxy: proxy)
                // A scroll that never reports its end still lets an owed correction run.
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(Int(TranscriptPlaceKeeper.animationLimit)))
                    keep(.tick, proxy: proxy)
                }
            @unknown default: break
            }
            intent.animating = phase == .animating
            TranscriptJumpHooks.scrolling(phase)
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
            if new.height != old.height { PerfCounters.bump("content.height") }
            let opened = intent.opened
            if intent.opened, new.height != old.height {
                // What opened grows under the row the person tapped, which stays put; the feed
                // follows the end again only if the end is still in view.
                intent.opened = false
                if reading.thread == nil { setFollowing(new.bottom <= AceDesign.Space.group) }
            }
            // Following, an end that grew past the bottom (a streaming answer) is followed from
            // here: the lazy tail row that also scrolls on each change isn't built once the end
            // is a screen away, so one burst of growth would otherwise leave it behind for good.
            if !opened, pinned, thread.loaded, !intent.active, !keyboardMoving,
               new.height > old.height, new.bottom > 1 { toEnd(proxy) }
            // Geometry is an observation, not a new scroll request. The bounded correction
            // already handles lazy-row remeasurement after a content or composer change.
            if thread.loaded, new.bottom <= 1 { ThreadOpenTrace.shared.settled(thread.id) }
            // Content that shrank under a still feed left it past its end: back to the real end,
            // so the rows show instead of the dark below them.
            if thread.loaded, TranscriptScrollIntent.Metrics.strandedPastEnd(old: old, new: new, moving: intent.active || intent.animating) {
                proxy.scrollTo(TranscriptTail.id, anchor: .bottom)
            }
            // Scroll to end follows the end's distance as it changes, mid-drag included: it floats
            // over the composer, so showing it moves nothing under the rows.
            defer { updateBehind() }
            if intent.active {
                // Leaving the end stops following at once; the bridge is told to hold the rows
                // once the reader is a screen away (`endRead`). The viewport is view state:
                // write it only when it changes, or every frame of a scroll re-evaluates the
                // whole feed.
                if new.y < old.y - 1 {
                    if viewport.direction != -1 { viewport.noteDirection(-1) }
                    if following { setFollowing(false) }
                }
                else if new.y > old.y + 1, viewport.direction != 1 { viewport.noteDirection(1) }
                endRead(moving: true)
                pageIfNeeded(proxy)
            }
        }
        return observeReading(scroller, proxy: proxy)
    }

    /// What the feed does when what it reads changes, in five chains short enough to type-check
    /// quickly (a single chain took the CI compiler too long).
    private func observeReading<Content: View>(_ content: Content, proxy: ScrollViewProxy) -> some View {
        let rows = observeRows(content, proxy: proxy)
        let layout = observeLayout(rows)
        let room = observeRoom(layout, proxy: proxy)
        let landing = observeLanding(room, proxy: proxy)
        return observeLifecycle(landing, proxy: proxy)
    }
    /// A focus landing (`TranscriptFocusLanding`): its target named, and its deadline.
    private func observeLanding<Content: View>(_ content: Content, proxy: ScrollViewProxy) -> some View {
        content
            // A turn's reply names its focus after its rows may have landed: aim at it now.
            .onChange(of: reading.landing.target) { _, _ in place(.targetNamed, proxy: proxy) }
            // Ticked when nothing else lays out: a row that never lands or a scroll that changes
            // nothing must not hold paging and the end's reads for good.
            .task(id: reading.landing.deadline) {
                guard let deadline = reading.landing.deadline else { return }
                try? await Task.sleep(for: .milliseconds(max(0, deadline - model.now())))
                guard !Task.isCancelled else { return }
                place(.deadline, proxy: proxy)
            }
    }
    /// Sends, disclosures, the window's rows and paging, focus requests and the thread loading.
    private func observeRows<Content: View>(_ content: Content, proxy: ScrollViewProxy) -> some View {
        content
            .onChange(of: acceptedSend) { _, _ in returnToEnd(proxy: proxy) }
            .onChange(of: shown.disclosures.opens) { _, _ in disclosuresChanged() }
            .onChange(of: shown.screen.blockOrder, initial: true) { _, _ in updateExtent() }
            .modifier(SpacerCounts(before: extent.before, after: extent.after))
            .onChange(of: reading.thread?.epoch) { _, _ in windowReplaced(proxy: proxy) }
            // The rows of an opened thread measure within a few frames of being drawn, and the scroll
            // to the end settles; then new rows and the reader's drags grow under a held top, as
            // before (`TranscriptGrowthAnchor`).
            .task(id: rowsPainted) {
                guard rowsPainted else { return }
                try? await Task.sleep(for: .seconds(1))
                while !Task.isCancelled, settle.isRunning || intent.animating {
                    try? await Task.sleep(for: .milliseconds(100))
                }
                guard !Task.isCancelled else { return }
                growth.openSettled()
            }
            .onChange(of: reading.loading) { _, loading in
                if loading, reading.operation == "older" {
                    intent.olderPage = true
                    TranscriptJumpHooks.begin("older", span: 4)
                }
                if !loading { pageIfNeeded(proxy) }
            }
            .onChange(of: TranscriptFeedRow.rows(shown).count) { _, count in
                restack(rows: count, moving: intent.active || intent.animating, replaced: false, proxy: proxy)
            }
            .onChange(of: reading.revision) { _, _ in readingRevised(proxy: proxy) }
            .onChange(of: model.focusOnOpen, initial: true) { _, _ in focusRequested() }
            .onChange(of: thread.loaded) { _, loaded in threadLoaded(loaded, proxy: proxy) }
    }
    /// Type size, density, the feed's size and the connection.
    private func observeLayout<Content: View>(_ content: Content) -> some View {
        content
            .onChange(of: typeSize) { _, _ in applyLayoutRevision() }
            .onChange(of: densityId) { _, _ in applyLayoutRevision() }
            // Rotation and split-view width changes invalidate measurements
            // automatically: only geometry (not paging or streaming) does.
            .onChange(of: feedFrame.size) { _, _ in applyLayoutRevision() }
            .onChange(of: model.connection) { _, connection in connectionChanged(connection) }
    }
    /// The keyboard and the composer: the room under the last row.
    private func observeRoom<Content: View>(_ content: Content, proxy: ScrollViewProxy) -> some View {
        content
            .onChange(of: keyboard.moves) { _, _ in keyboardWillMove(proxy: proxy) }
            .onChange(of: keyboard.landings) { _, _ in keyboardLanded(proxy: proxy) }
            .onChange(of: barHeight) { old, new in
                // The composer opening as it takes the keyboard moves on the keyboard's spring.
                let motion: Animation = keyboardMoving ? AceDesign.Motion.keyboard(keyboard.duration) : .default
                roomChanged(by: new - old, motion: reduceMotion ? nil : motion, proxy: proxy)
            }
    }
    /// Appearing and leaving, and Scroll to end.
    private func observeLifecycle<Content: View>(_ content: Content, proxy: ScrollViewProxy) -> some View {
        content
            .task { appeared(proxy: proxy) }
            .task(id: ready) { if ready, !revealed { revealWhenSettled() } }
            .onDisappear { disappeared() }
            // Away from the end, or reading a window apart from it: following a joined window is at
            // the end, so Scroll to end isn't offered there.
            .onChange(of: !pinned, initial: true) { _, _ in updateBehind() }
            // A history window that catches up with the live end while the reader sits at its end
            // follows it again, so Scroll to end goes.
            .onChange(of: reading.joined) { _, joined in windowJoined(joined) }
            .onChange(of: jumps) { _, _ in returnToEnd(proxy: proxy) }
            .modifier(TranscriptTopEdge())
            .modifier(ReaderAtEnd(model: model, thread: thread, atEnd: pinned && thread.loaded))
    }
    /// A sent message or a Scroll to end tap: back to the live end, following it.
    private func returnToEnd(proxy: ScrollViewProxy) {
        readerTookOver(proxy)
        reading.toEnd(model: model, thread: thread)
        setFollowing(true)
        toEnd(proxy)
    }
    private func disclosuresChanged() {
        readerMovedFeed()
        intent.opened = true
        // Anchor the disclosure while reading history; the live end keeps following.
        if !following || reading.thread != nil, let top = currentTopRow() {
            viewport.toggle(rowID: top.rowID, itemID: top.itemID, top: top.top)
        }
        applyLayoutRevision()
    }
    /// A new history window: its rows replace the extent's.
    private func windowReplaced(proxy: ScrollViewProxy) {
        extent.update(change: TranscriptExtent.WindowChange(
            ids: shown.screen.blockOrder.map { "block:\($0)" }, movement: .replace))
        let rows: [TranscriptFeedRow] = TranscriptFeedRow.rows(shown)
        lastBlockItems = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0.block.row.items) })
        restack(rows: rows.count, moving: intent.active || intent.animating, replaced: true, proxy: proxy)
    }
    /// The rows' count changed, their window was replaced, or the feed came to rest: move the rows
    /// to the other stack if `TranscriptStackChoice` says so. A switch lays every row out again,
    /// so the reader's place is installed as a session anchor, restored once the rows measure, and
    /// a feed following the end goes back to it.
    private func restack(rows: Int, moving: Bool, replaced: Bool, proxy: ScrollViewProxy) {
        guard ready, anchor.stack.update(rows: rows, moving: moving, replaced: replaced) != nil else { return }
        if !following, let top = currentTopRow() {
            viewport.noteSessionAnchor(TranscriptHeldAnchor(rowID: top.rowID, itemID: top.itemID, top: top.top))
        }
        stackSwitches += 1
        PerfProbe.add("feed.restacks", 1)
        if following { toEnd(proxy) }
    }
    /// The history window's rows changed: restore, focus or hold the reader's place.
    private func readingRevised(proxy: ScrollViewProxy) {
        guard reading.thread != nil else { return }
        if UIAccessibility.isVoiceOverRunning { viewport.clearSessionAnchor() }
        updateExtent()
        let rows = TranscriptFeedRow.rows(shown)
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
    private func threadLoaded(_ loaded: Bool, proxy: ScrollViewProxy) {
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
    private func connectionChanged(_ connection: String) {
        if connection == "ready", reading.thread != nil, !reading.loading {
            reading.refreshAfterReconnect(model: model, live: thread, anchorItemId: currentAnchorItemID())
        }
    }
    /// The keyboard is moving (`KeyboardRide`), and the composer with it. Rows following the end
    /// are drawn up by the same lift in the same frames, so the two move as one (#2170): an animated
    /// scroll can't, as it runs on the scroll view's own curve and starts frames late. The room
    /// changes at once; only drawing moves until the ride lands (`keyboardLanded`), and the only
    /// part of the feed it brings into view is the empty room under the last row.
    private func keyboardWillMove(proxy: ScrollViewProxy) {
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
    private func keyboardLanded(proxy: ScrollViewProxy) {
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
    private func appeared(proxy: ScrollViewProxy) {
        TranscriptJumpHooks.begin("open", hidden: !revealed)
        model.readingWillMove = { captureTop(); holdOlderPage() }
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
    private static func rebuildOnOverflow(anchor: TranscriptReadingAnchor, intent: TranscriptScrollIntent,
                                          reading: TranscriptReading, thread: ThreadModel, model: ClientModel) -> () -> Void {
        return {
            guard reading.thread != nil, !reading.loading else { return }
            let shown: ThreadModel = reading.shown ?? thread
            let rows: [TranscriptFeedRow] = TranscriptFeedRow.rows(shown)
            let topID: String? = anchor.keeper.frames.topRow(of: rows.map(\.id), inset: intent.metrics.topInset)
            let first: TranscriptFeedRow? = rows.first { $0.id == topID }
            let item: String? = first?.block.row.items.first ?? reading.lastAnchorItemId
            if let item { reading.rebuild(model: model, live: thread, anchorItemId: item) }
        }
    }
    private func disappeared() {
        settle.cancel()
        surface.stopAll()
        surface.thaw()
        saveSession()
        reading.cancel(model: model)
        model.readingWillMove = nil
        model.readingMoved = nil
        model.onReadingNeedsFresh = nil
    }
    private func windowJoined(_ joined: Bool) {
        if joined, reading.thread != nil, !intent.active, intent.metrics.bottom <= AceDesign.Space.group { setFollowing(true) }
        updateBehind()
    }
    /// Shows or hides Scroll to end by where the end is now (`TranscriptEndButton`); writes only
    /// on a change, so a scroll's frames don't re-evaluate the thread.
    private func updateBehind() {
        let shows = TranscriptEndButton.shows(.init(fromEnd: Double(intent.metrics.bottom), slack: Double(AceDesign.Space.group),
                                                    following: following, windowApart: reading.thread != nil && !reading.joined))
        if behind != shows { behind = shows }
    }
    /// The room at the end changed (the composer or its strip). Following the end,
    /// the last row moves with it, in the same motion; reading elsewhere, the rows stay put and
    /// are covered, unless the smaller room would park the view past the end.
    private func roomChanged(by growth: CGFloat, motion: Animation?, proxy: ScrollViewProxy) {
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
    private func revealWhenSettled() {
        let intent = intent
        let started = CACurrentMediaTime()
        var settle = TranscriptSettle(at: started)
        surface.untilSettled(.reveal, { time in
            let metrics = intent.metrics
            let placed = TranscriptSettle.opened(following: pinned, fromEnd: Double(metrics.bottom),
                                                 restoring: viewport.sessionAnchor != nil || reading.loading)
            return settle.frame([Double(metrics.height), Double(metrics.y)], placed: placed, at: time)
        }) { outcome in
            var still = Transaction()
            still.disablesAnimations = true
            withTransaction(still) { revealed = true }
            TranscriptJumpHooks.revealed(after: CACurrentMediaTime() - started, capped: outcome == .capped)
        }
    }
    /// An older page is about to join above the reader's line. What is drawn is frozen over the
    /// feed while its rows land and measure; each frame the row on top is put back at its height
    /// on screen from its own measured frame, then the feed thaws (`TranscriptSurface`).
    private func holdOlderPage() {
        guard intent.olderPage else { return }
        intent.olderPage = false
        // A hidden feed has nothing to hold: the reveal waits for it to settle.
        guard revealed, !surface.holding, let top = currentTopRow(),
              let held = anchor.keeper.frames.inContent(top.rowID) else { return }
        let onScreen = Double(held.minY) - surface.offset
        guard surface.freeze() else { return }
        TranscriptJumpHooks.covered(true)
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
            surface.thaw()
            TranscriptJumpHooks.covered(false)
        }
    }
    /// The reader took the feed mid-hold: it's theirs as it is.
    private func endPageHold() {
        surface.stop(.page)
        surface.thaw()
        TranscriptJumpHooks.covered(false)
    }
    private func toEnd(_ proxy: ScrollViewProxy) {
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
    private func stepTurn(_ direction: Int, proxy: ScrollViewProxy) {
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
    private func jump(to row: TranscriptFeedRow, proxy: ScrollViewProxy) {
        keep(.jumped(row.id), proxy: proxy)
        withAnimation { proxy.scrollTo(row.id, anchor: .top) }
    }
    /// A search hit asked for an item in this thread: the shared window opens around it.
    private func focusRequested() {
        guard thread.loaded, let focus = model.focusOnOpen, focus.thread == thread.id else { return }
        model.focusOnOpen = nil
        setFollowing(false)
        if let turn = focus.turn { reading.jump(toTurn: turn, model: model, live: thread) }
        else { reading.jump(to: focus.item, model: model, live: thread) }
    }
    /// The reader took the feed somewhere themselves (a drag, a turn key, Scroll to end, a
    /// send, VoiceOver): a focus still landing or still awaited stops pulling them back.
    private func readerTookOver(_ proxy: ScrollViewProxy) {
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
    private func rowShowing(_ item: String) -> String? {
        reading.shown.flatMap { TranscriptFeedRow.rows($0).first { $0.block.row.items.contains(item) }?.id }
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
            let frame = anchor.keeper.frames.frame(session.rowID) else { return }
        let metrics = intent.metrics
        let top = Double(frame.minY) - Double(metrics.topInset)
        if TranscriptRowPlacement.settled(top: top, target: session.top) {
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
        let inset = intent.metrics.topInset
        let rows = TranscriptFeedRow.rows(shown)
        guard let id = anchor.keeper.frames.topRow(of: rows.map(\.id), inset: inset),
            let first = rows.first(where: { $0.id == id }) else { return nil }
        return (rowID: first.id, itemID: first.block.row.items.first, top: anchor.keeper.frames.top(first.id, inset: inset) ?? 0)
    }
    /// Takes the row at the top as the one to hold.
    private func captureTop() {
        guard let top = currentTopRow() else { return }
        viewport.noteCaptured(rowID: top.rowID, itemID: top.itemID, top: top.top)
    }
    /// A row's pixel top in viewport coordinates, for the viewport controller.
    private func rowTop(_ rowID: String) -> Double {
        anchor.keeper.frames.top(rowID, inset: intent.metrics.topInset) ?? 0
    }
    /// A row was laid out at `frame` in the content: on coming on screen, or when it or a row
    /// above it changed height. Heights feed the extent; the place keeper puts a held row back.
    private func rowLaidOut(_ id: String, frame: CGRect, proxy: ScrollViewProxy) {
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
    private func contentScrolled(to origin: CGFloat, proxy: ScrollViewProxy) {
        let before = anchor.keeper.frames.origin
        keep(.origin(origin), proxy: proxy)
        if anchor.keeper.frames.origin != before, viewport.sessionAnchor != nil { applySessionRestore(proxy: proxy) }
    }
    /// What the feed allows the place keeper now.
    private func placeFacts() -> TranscriptPlaceKeeper.Facts {
        let restoring = viewport.sessionAnchor != nil
        return TranscriptPlaceKeeper.Facts(held: viewport.held, inset: intent.metrics.topInset,
            mayCapture: viewport.mode == .reading && !viewport.isAiming && !restoring,
            mayCorrect: viewport.canCorrect && !viewport.isAiming && !restoring && viewport.mode != .following
                && !UIAccessibility.isVoiceOverRunning)
    }
    /// Hands `event` to the place keeper and does what it decides: hold a row, or scroll one back.
    /// Pure-geometry drift (async Markdown and media sizing) is corrected there, bounded by the
    /// viewport's budget and never during a gesture, a jump re-aiming, VoiceOver or following.
    private func keep(_ event: TranscriptPlaceKeeper.Event, proxy: ScrollViewProxy) {
        place(.keeper(event), proxy: proxy)
    }
    /// Routes `event` between the place keeper and a landing focus (`TranscriptFeedPlace`) and
    /// does what they decide. The landing is written back only when it changed, so a scroll
    /// with no focus landing writes nothing the feed observes.
    private func place(_ event: TranscriptFeedPlace.Event, proxy: ScrollViewProxy) {
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
                    : TranscriptFeedRow.rows(shown).first { $0.id == id }?.block.row.items.first
                viewport.noteCaptured(rowID: id, itemID: item, top: top)
            case .place(let id, let top):
                if !placeRowAtTop(id, top: top, proxy: proxy) { proxy.scrollTo(id, anchor: .top) }
                viewport.noteCorrectionApplied()
            case .aim(let id, let fraction):
                proxy.scrollTo(id, anchor: fraction.map { UnitPoint(x: 0, y: $0) } ?? .center)
            case .released: pageIfNeeded(proxy)
            }
        }
    }
    /// Scroll so `rowID` sits `top` points below the viewport top. Returns
    /// false when the row fills the viewport (caller falls back to top
    /// alignment). Fraction math keeps partial rows as well as top-aligned
    /// ones, like the capture/restore fraction.
    @discardableResult
    private func placeRowAtTop(_ rowID: String, top: Double, proxy: ScrollViewProxy) -> Bool {
        guard let frame = anchor.keeper.frames.frame(rowID) else { return false }
        let metrics = intent.metrics
        guard let fraction = TranscriptAnchorPlacement.fraction(top: top,
            viewport: Double(metrics.viewport), topInset: Double(metrics.topInset),
            bottomInset: Double(metrics.bottomInset), rowHeight: Double(frame.height)) else { return false }
        proxy.scrollTo(rowID, anchor: UnitPoint(x: 0, y: fraction))
        return true
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

    /// Tells the bridge the reader left the end or came back to it, when that changed
    /// (`TranscriptEndRead`), never on each turn of a gesture near the end.
    private func endRead(moving: Bool) {
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

    /// Approaching a resident edge loads another page. A fling into retained space keeps
    /// loading after the finger lifts, until real rows cover the viewport again.
    private func pageIfNeeded(_ proxy: ScrollViewProxy) {
        guard thread.loaded, !reading.loading, model.readingSettled, reading.problem == nil,
            !reading.landing.holdsPlace else { return }
        let inRetainedSpace = extent.needsContent(top: intent.metrics.top, bottom: intent.metrics.bottom)
        guard inRetainedSpace || (intent.active && !intent.consumed) else { return }
        let ahead = max(AceDesign.Size.tap, intent.metrics.viewport * 1.5)
        let edge = extent.edge(top: intent.metrics.top, bottom: intent.metrics.bottom, ahead: ahead, direction: viewport.direction)
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

/// Fixture builds count the spacers' changes (`PerfCounters`); elsewhere it adds nothing.
private struct SpacerCounts: ViewModifier {
    let before: Double
    let after: Double
    func body(content: Content) -> some View {
        #if ACE_FIXTURE
        content
            .onChange(of: before) { _, _ in PerfCounters.bump("extent.spacers") }
            .onChange(of: after) { _, _ in PerfCounters.bump("extent.spacers") }
        #else
        content
        #endif
    }
}

/// The header over the transcript: on iOS 26 and later the bar draws nothing of its own and the
/// thread's header bar sets the system's scroll-edge effect (`ThreadHeaderBar`). Before, the bar is
/// opaque in the page colour.
private struct TranscriptTopEdge: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
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
            // The web's keys by default; Settings › Keyboard can move them.
            Button("Previous turn") { step(-1) }.phoneShortcut("previousTurn")
            Button("Next turn") { step(1) }.phoneShortcut("nextTurn")
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
