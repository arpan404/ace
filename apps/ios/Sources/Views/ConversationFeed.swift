import SwiftUI

/// One lazy reading column. Edge scrolling avoids List's stale collection-index scroll targets.
///
/// Every scroll the feed makes is a one-shot `ScrollViewProxy` call. A `ScrollPosition` binding
/// keeps its last target (an edge, an offset or a row) standing until the person scrolls; with an
/// accessibility client attached (VoiceOver, Voice Control, UI automation), a drag against that
/// standing target re-places the lazy rows on every update and pins the main thread.
struct ConversationFeed: View {
    @Environment(\.aceReduceMotion) var reduceMotion
    @Environment(\.dynamicTypeSize) var typeSize
    @Environment(\.markdownShelf) var markdownShelf
    @Environment(\.aceDensityId) var densityId
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
    @State var reading = TranscriptReading()
    @State var initialScroll = false
    @State var sessionRestored = false
    @State var intent = TranscriptScrollIntent()
    @State var settle = TranscriptEndSettle()
    @State var anchor = TranscriptReadingAnchor()
    /// Bumped when the rows move to the other stack (`restack`).
    @State var stackSwitches = 0
    @State var extent = TranscriptExtent()
    @State var viewport = TranscriptViewportController()
    /// The room the keyboard takes under the last row (`TranscriptKeyboardRoom`).
    @State var keyboardRoom = TranscriptKeyboardRoom()
    /// How far the keyboard reaches above the feed's bottom edge.
    var keyboardLift: CGFloat { CGFloat(keyboardRoom.kept) }
    /// The rows follow the end on the keyboard's ride (`keyboardWillMove`), drawn up by its lift
    /// beyond the lift the scroll already allows for (`TranscriptKeyboardFollow`). Only drawing
    /// moves: rows measure and the scroll reads as if they didn't.
    @State var keyboardFollow = TranscriptKeyboardFollow()
    /// While the keyboard moves, the live tail doesn't jump to the end on each delta: the
    /// keyboard's ride carries the rows there.
    @State var keyboardMoving = false
    @State var feedFrame: CGRect = .zero
    /// The edge that holds still while lazy rows correct their heights (`TranscriptGrowthAnchor`).
    @State var growth = TranscriptGrowthAnchor()
    /// A row has been drawn since the feed appeared: the opening's hold counts from here.
    @State var rowsPainted = false
    /// The feed is shown: a thread opening stays hidden until its end has settled (ADR 0157).
    @State var revealed = false
    /// The scroll view under the rows, for the reveal and an older page's hold (`TranscriptSurface`).
    @State var surface = TranscriptSurface()
    var shown: ThreadModel { reading.shown ?? thread }
    var ready: Bool { thread.loaded }
    /// The viewport controller owns the follow mode; the feed never keeps its
    /// own copy. All transitions go through `setFollowing`, which also captures
    /// the semantic anchor when leaving the end.
    var following: Bool { viewport.mode == .following }
    func setFollowing(_ value: Bool) {
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
    var holdsEnd: Bool { growth.keepsEnd || (!rowsPainted && following) }
    /// The reader moved the feed or changed what it holds: size changes keep the top again.
    func readerMovedFeed() {
        if growth.keepsEnd { growth.readerMoved() }
        if surface.running(.page) { endPageHold() }
    }
    var pinned: Bool { following && (reading.thread == nil || reading.joined) }
    /// History rows are stale disk cache when the bridge said `.cached`, or
    /// whenever the history window is open while offline. Offline can happen
    /// with no new read reply, so connectivity derives stale too. The live
    /// tail stays enabled: only the open history window reads stale.
    var historyStale: Bool {
        reading.isStale || (reading.thread != nil && model.connection != "ready")
    }

    var body: some View {
        // A passage opened in a row is one of the thread's folds: the feed holds the reader's place.
        ScrollViewReader { proxy in feed(proxy) }
            .environment(\.expansions, shown.disclosures)
    }

    /// The scroll view's own frame, header and home indicator included.
    nonisolated static let viewportSpace = "transcript.viewport"
    /// The scrolling content: rows keep their frames in it while the feed scrolls.
    nonisolated static let contentSpace = "transcript.content"

    func feed(_ proxy: ScrollViewProxy) -> some View {
        // The stack for these rows (ADR 0157): chosen before they first lay out, switched only by
        // `restack`, which bumps `stackSwitches` to lay them out again in the other one.
        let _ = stackSwitches
        let rowCount = shown.screen.blockOrder.count
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
                    TranscriptSpacer(extent: extent, height: \.before)
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
                    TranscriptSpacer(extent: extent, height: \.after)
                } else { ConversationSkeleton(opening: opening, retry: retryOpening) }
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
                TranscriptTail(thread: thread, following: pinned, barHeight: barHeight) {
                    if !keyboardMoving && !intent.active { toEnd(proxy) }
                }
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
            } else if reading.thread == nil {
                // Kept rows while the machine connects: marked over the rows, never moving them.
                ThreadSyncingLine(opening: opening, retry: retryOpening).animation(.default, value: opening)
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
            // The hold only moves a feed at rest; any scroll it didn't make (a finger, VoiceOver's
            // three-finger swipe, Switch Control) ends it where the reader is.
            if surface.running(.page), phase != .idle { endPageHold() }
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
                   Self.assistiveScrolling {
                    readerTookOver(proxy)
                }
                // After the follow mode above: where the scroll came to rest is held, and a
                // correction owed while it ran is made (`TranscriptPlaceKeeper`).
                keep(.phase(.idle), proxy: proxy)
                restack(rows: shown.screen.blockOrder.count, moving: false, replaced: false, proxy: proxy)
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
                bottom: CGFloat(ScrollEnd.fromEnd(contentHeight: geometry.contentSize.height, offsetY: geometry.contentOffset.y,
                                                  containerHeight: geometry.containerSize.height, topInset: insets.top)),
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
    func observeReading<Content: View>(_ content: Content, proxy: ScrollViewProxy) -> some View {
        let rows = observeRows(content, proxy: proxy)
        let layout = observeLayout(rows)
        let room = observeRoom(layout, proxy: proxy)
        let landing = observeLanding(room, proxy: proxy)
        return observeLifecycle(landing, proxy: proxy)
    }
    /// A focus landing (`TranscriptFocusLanding`): its target named, and its deadline.
    func observeLanding<Content: View>(_ content: Content, proxy: ScrollViewProxy) -> some View {
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
    func observeRows<Content: View>(_ content: Content, proxy: ScrollViewProxy) -> some View {
        content
            .onChange(of: acceptedSend) { _, _ in returnToEnd(proxy: proxy) }
            .onChange(of: shown.disclosures.opens) { _, _ in disclosuresChanged() }
            .onChange(of: shown.screen.blockOrder, initial: true) { _, ids in
                markdownShelf?.keepOwners(ids)
                updateExtent(rows: TranscriptFeedRow.rows(shown))
            }
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
            .onChange(of: shown.screen.blockOrder.count) { _, count in
                restack(rows: count, moving: intent.active || intent.animating, replaced: false, proxy: proxy)
            }
            .onChange(of: reading.revision) { _, _ in readingRevised(proxy: proxy) }
            .onChange(of: model.focusOnOpen, initial: true) { _, _ in focusRequested() }
            .onChange(of: thread.loaded) { _, loaded in threadLoaded(loaded, proxy: proxy) }
    }
    /// Type size, density, the feed's size and the connection.
    func observeLayout<Content: View>(_ content: Content) -> some View {
        content
            .onChange(of: typeSize) { _, _ in applyLayoutRevision() }
            .onChange(of: densityId) { _, _ in applyLayoutRevision() }
            // Rotation and split-view width changes invalidate measurements
            // automatically: only geometry (not paging or streaming) does.
            .onChange(of: feedFrame.size) { _, _ in applyLayoutRevision() }
            .onChange(of: model.connection) { _, connection in connectionChanged(connection) }
    }
    /// The keyboard and the composer: the room under the last row.
    func observeRoom<Content: View>(_ content: Content, proxy: ScrollViewProxy) -> some View {
        content
            .onChange(of: keyboard.moves) { _, _ in keyboardWillMove(proxy: proxy) }
            .onChange(of: keyboard.landings) { _, _ in keyboardLanded(proxy: proxy) }
            .onChange(of: barHeight) { old, new in
                // Growing room moves the tail immediately so a new pill can't cover the last row.
                let motion: Animation? = keyboardMoving ? AceDesign.Motion.keyboard(keyboard.duration) : (new < old ? .default : nil)
                roomChanged(by: new - old, motion: reduceMotion ? nil : motion, proxy: proxy)
            }
    }
    /// Appearing and leaving, and Scroll to end.
    func observeLifecycle<Content: View>(_ content: Content, proxy: ScrollViewProxy) -> some View {
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
}
