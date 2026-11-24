import SwiftUI

/// Newest-first storage, drawn in chronological order. Older pages extend the far edge.
///
/// The rows live in a flipped `UICollectionView` (`TranscriptCollection`, ADR 0222) whose layout
/// owns every implicit offset change. Every scroll the feed makes is a one-shot `TranscriptSurface`
/// call; nothing stands as a target the scroll view keeps re-placing rows against.
struct ConversationFeed: View {
    @Environment(\.aceReduceMotion) var reduceMotion
    @Environment(\.dynamicTypeSize) var typeSize
    @Environment(\.markdownShelf) var markdownShelf
    @Environment(\.transcriptMarkdown) var transcriptMarkdown
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
    /// Rows that landed since the reader left the live end, for the count on Scroll to end.
    @Binding var unseen: Int
    @State var newRows = TranscriptNewRows()
    /// When the row on top was written, for the pill shown while the reader scrolls.
    @State var timeMarker = TranscriptTimeMarker()
    /// Words taken back from a message that wasn't sent go into the composer.
    @State var reading = TranscriptReading()
    @State var initialScroll = false
    @State var sessionRestored = false
    @State var intent = TranscriptScrollIntent()
    @State var settle = TranscriptEndSettle()
    @State var anchor = TranscriptReadingAnchor()
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
    @State var feedSize: CGSize = .zero
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
        GeometryReader { viewport in
            feed(surface)
                .frame(width: viewport.size.width, height: viewport.size.height)
                .clipped()
        }
            .environment(\.expansions, shown.disclosures)
            .environment(\.transcriptShowingHistory, reading.shown != nil)
    }

    func feed(_ proxy: TranscriptSurface) -> some View {
        PerfCounters.bump("feed.body")
        let scroller = TranscriptCollection(
            entries: entries(proxy), surface: surface, events: scrollEvents(proxy),
            estimate: { [anchor = anchor] id in anchor.keeper.frames.frame(id).map { CGFloat($0.height) } },
            style: AnyHashable([String(describing: typeSize), densityId]),
            keyboardUp: keyboardLift > 0, followsEnd: pinned,
            accessibilityValue: ready ? (historyStale ? "Cached history" : reading.paged && !pinned ? "Reading history" : "Ready") : "Loading")
            // Hidden while a thread opens, then shown where it settled (`revealWhenSettled`).
            .opacity(ready && !revealed ? 0 : 1)
            // The rows following the end ride the keyboard; only drawing moves.
            .modifier(KeyboardRideOffset(ride: keyboard, base: CGFloat(keyboardFollow.base), riding: keyboardFollow.riding))
            .modifier(TranscriptTopEdge())
            .onGeometryChange(for: CGSize.self) { $0.size } action: { feedSize = $0 }
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
            // Over the rows, never in their layout: the pill reads its marker, the feed doesn't.
            .overlay(alignment: .top) {
                TranscriptTimePill(marker: timeMarker).padding(.top, AceDesign.Space.related)
            }
            // ⇧⌥⌘↑ and ↓ on a hardware keyboard, as on the web: the turn before and after the one on
            // top. They repeat the thread menu's Turns list, never the only way.
            .background { TurnKeys { stepTurn($0, proxy: proxy) } }
        return observeReading(scroller, proxy: proxy)
    }

    /// The feed's entries in physical order, the live end first (ADR 0222).
    func entries(_ proxy: TranscriptSurface) -> [TranscriptEntry] {
        func entry(_ id: String, _ key: AnyHashable, row: Bool = false, @ViewBuilder _ content: @escaping () -> some View) -> TranscriptEntry {
            TranscriptEntry(id: id, key: key, isRow: row) {
                AnyView(content()
                    .modifier(TranscriptTextSize())
                    // A comfortable line on a wide window; the scroll itself stays full width.
                    .frame(maxWidth: ReadingColumn.maxWidth)
                    .frame(maxWidth: .infinity))
            }
        }
        func room(_ id: String, _ height: CGFloat) -> TranscriptEntry {
            entry(id, height) { Color.clear.frame(height: height).accessibilityHidden(true) }
        }
        var list: [TranscriptEntry] = []
        list.append(room("room.keyboard", CGFloat(keyboardRoom.leaving)))
        let follows = self.pinned, bar = self.barHeight, live = self.thread
        list.append(entry(TranscriptTail.id, [follows, bar] as [AnyHashable]) {
            TranscriptTail(thread: live, following: follows, barHeight: bar) {
                if !keyboardMoving && !intent.active { toEnd(proxy) }
            }
        })
        let barRoom = barHeight + keyboardLift + AceDesign.Space.group
        list.append(entry("room.bar", barRoom) {
            Color.clear.frame(height: barRoom).accessibilityHidden(true).keyboardDriftMark(.line)
        })
        let model = self.model
        list.append(entry("review.ready", 0) { ReviewReadyLine(model: model) })
        if reading.thread == nil || reading.joined {
            let canOperate = model.canOperate
            for row in model.pending.values.filter({ $0.threadId == thread.id && $0.state != "delivered" && thread.items["input:\($0.id)"] == nil }).sorted(by: { $0.id > $1.id }) {
                list.append(entry("pending:\(row.id)", [row.state, row.text, row.label ?? "", String(canOperate)]) {
                    PendingSendRow(row: row, canRetry: canOperate, retry: { await model.retrySend(row) },
                                   words: { await model.sendWords(row.id) },
                                   saveWords: { await model.editFailedSend(row.id, text: $0) },
                                   discard: { await model.dismissSend(row.id) })
                        .padding(.horizontal, AceDesign.Space.margin).padding(.vertical, AceDesign.Space.tight)
                })
            }
        }
        if ready {
            list.append(room("spacer.after", CGFloat(extent.after)))
            let shown = self.shown, links = self.links, stale = historyStale
            let rows = TranscriptFeedRow.rows(shown)
            for row in rows.reversed() {
                let key: [AnyHashable] = [ObjectIdentifier(row.block), row.room, ObjectIdentifier(shown), links.key, stale]
                list.append(entry(row.id, key, row: true) {
                    TranscriptFeedRowView(row: row, thread: shown, links: links).equatable()
                        .accessibilityElement(children: .contain)
                        .transcriptJumpMark(row.id)
                        .disabled(stale)
                })
            }
            list.append(room("spacer.before", CGFloat(extent.before)))
            if stale {
                let cached = reading.isStale, loading = reading.loading
                list.append(entry("history.cached", [cached, loading]) {
                    HStack(spacing: AceDesign.Space.related) {
                        Text(cached ? "Cached history" : "Offline — cached history")
                            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.subtleForeground)
                            .accessibilityLabel("Cached history")
                        Spacer()
                        Button("Retry") { retryHistory() }
                            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .disabled(loading)
                            .accessibilityIdentifier("transcript.cached.retry")
                    }
                    .padding(.horizontal, AceDesign.Space.margin)
                    .padding(.vertical, AceDesign.Space.tight)
                    .accessibilityElement(children: .combine)
                    .accessibilityHint("Shows saved history until the thread reconnects")
                })
            }
        } else {
            let opening = self.opening
            list.append(entry("skeleton", String(describing: opening)) {
                ConversationSkeleton(opening: opening, retry: retryOpening)
            })
        }
        if let problem = reading.problem {
            list.append(entry("problem", problem) {
                VStack {
                    ServiceProblem(message: problem)
                    Button("Retry loading messages") { reading.retry(model: model, live: thread) }
                        .frame(minHeight: AceDesign.Size.tap)
                }
            })
        }
        list.append(room("room.edge", AceDesign.Space.related))
        return list
    }

    /// What the feed does when what it reads changes, in five chains short enough to type-check
    /// quickly (a single chain took the CI compiler too long).
    func observeReading<Content: View>(_ content: Content, proxy: TranscriptSurface) -> some View {
        let rows = observeRows(content, proxy: proxy)
        let layout = observeLayout(rows)
        let room = observeRoom(layout, proxy: proxy)
        let landing = observeLanding(room, proxy: proxy)
        return observeLifecycle(landing, proxy: proxy)
    }
    /// A focus landing (`TranscriptFocusLanding`): its target named, and its deadline.
    func observeLanding<Content: View>(_ content: Content, proxy: TranscriptSurface) -> some View {
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
    func observeRows<Content: View>(_ content: Content, proxy: TranscriptSurface) -> some View {
        content
            .onChange(of: acceptedSend) { _, _ in returnToEnd(proxy: proxy) }
            .onChange(of: shown.disclosures.opens) { _, _ in disclosuresChanged() }
            .onChange(of: shown.screen.blockOrder, initial: true) { _, ids in
                markdownShelf?.keepOwners(ids)
                // Reading revisions carry the page evidence and update the extent themselves.
                if reading.shown == nil { updateExtent(rows: TranscriptFeedRow.rows(shown)) }
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
            .onChange(of: feedSize) { _, _ in applyLayoutRevision() }
            .onChange(of: model.connection) { _, connection in connectionChanged(connection) }
    }
    /// The keyboard and the composer: the room under the last row.
    func observeRoom<Content: View>(_ content: Content, proxy: TranscriptSurface) -> some View {
        content
            .onChange(of: keyboard.moves) { _, _ in keyboardWillMove(proxy: proxy) }
            .onChange(of: keyboard.landings) { _, _ in keyboardLanded(proxy: proxy) }
            .onChange(of: barHeight) { old, new in
                TranscriptJumpHooks.note("bar \(Int(old))>\(Int(new))")
                // Growing room moves the tail immediately so a new pill can't cover the last row.
                let motion: Animation? = keyboardMoving ? AceDesign.Motion.keyboard(keyboard.duration) : (new < old ? .default : nil)
                roomChanged(by: new - old, motion: reduceMotion ? nil : motion, proxy: proxy)
            }
    }
    /// Appearing and leaving, and Scroll to end.
    func observeLifecycle<Content: View>(_ content: Content, proxy: TranscriptSurface) -> some View {
        content
            .task { appeared(proxy: proxy) }
            .task(id: ready) { if ready, !revealed { revealWhenSettled() } }
            .onDisappear { disappeared() }
            // Away from the end, or reading a window apart from it: following a joined window is at
            // the end, so Scroll to end isn't offered there.
            .onChange(of: !pinned, initial: true) { _, away in
                updateBehind()
                if !away { countNewRows() }
            }
            // New rows while the reader is away from the end are counted, never scrolled to.
            .onChange(of: thread.screen.blockOrder) { _, _ in countNewRows() }
            // A history window that catches up with the live end while the reader sits at its end
            // follows it again, so Scroll to end goes.
            .onChange(of: reading.joined) { _, joined in windowJoined(joined) }
            .onChange(of: jumps) { _, _ in returnToEnd(proxy: proxy) }
            .modifier(ReaderAtEnd(model: model, thread: thread, atEnd: pinned && thread.loaded))
    }
}
