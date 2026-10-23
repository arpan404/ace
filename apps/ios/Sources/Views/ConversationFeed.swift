import SwiftUI

/// Gesture intent is consumed once per page; layout changes and programmatic scrolls never page.
private final class TranscriptScrollIntent {
    var active = false
    var consumed = false
    /// The room under the rows when the content height was last seen: a change of room scrolls
    /// itself, with the keyboard's or the composer's motion.
    var room: CGFloat = 0
    var direction = 0
    var metrics = Metrics(y: 0, top: 0, bottom: 0, viewport: 0, topInset: 0, bottomInset: 0, height: 0)
    struct Metrics: Equatable { let y: CGFloat; let top: CGFloat; let bottom: CGFloat; let viewport: CGFloat; let topInset: CGFloat; let bottomInset: CGFloat; let height: CGFloat }
    func begin() { active = true; consumed = false; direction = 0 }
}

/// One lazy reading column. Edge scrolling avoids List's stale collection-index scroll targets.
///
/// Every scroll the feed makes is a one-shot `ScrollViewProxy` call. A `ScrollPosition` binding
/// keeps its last target (an edge, an offset or a row) standing until the person scrolls; with an
/// accessibility client attached (VoiceOver, Voice Control, UI automation), a drag against that
/// standing target re-places the lazy rows on every update and pins the main thread.
struct ConversationFeed: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
    @State private var reading = TranscriptReading()
    @State private var following = true
    @State private var initialScroll = false
    @State private var intent = TranscriptScrollIntent()
    @State private var anchor = TranscriptReadingAnchor()
    /// How far the keyboard reaches above the feed's bottom edge.
    @State private var keyboardLift: CGFloat = 0
    /// While the keyboard moves, the live tail doesn't jump to the end on each delta: the
    /// keyboard's own animation carries the rows there.
    @State private var keyboardMoving = false
    @State private var feedBottom: CGFloat = 0
    private var shown: ThreadModel { reading.shown ?? thread }
    private var ready: Bool { thread.loaded }
    private var pinned: Bool { following && reading.thread == nil }

    var body: some View {
        ScrollViewReader { proxy in feed(proxy) }
    }

    private func feed(_ proxy: ScrollViewProxy) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                if reading.loading, reading.operation == "older" || reading.operation == "newer" {
                    AceShape.capsule.fill(AceTheme.Colours.fill).frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Spacing.sm)
                        .padding(AceTheme.Spacing.lg).frame(maxWidth: .infinity)
                        .accessibilityLabel("Loading messages").accessibilityIdentifier("transcript.paging")
                }
                if let problem = reading.problem {
                    ServiceProblem(message: problem)
                    Button("Retry loading messages") { reading.retry(model: model, live: thread) }
                        .frame(minHeight: AceTheme.Dimensions.touchTarget)
                }
                if ready {
                    ForEach(TranscriptFeedRow.rows(shown)) { row in
                        TranscriptFeedRowView(row: row, thread: shown, links: links).id(row.id)
                            .onAppear { ThreadOpenTrace.shared.painted(thread.id) }
                            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named("transcript.viewport")) } action: { frame in
                                anchor.frames[row.id] = frame
                            }
                            .onDisappear { anchor.frames[row.id] = nil }
                    }
                } else { ConversationSkeleton().padding(AceTheme.Spacing.xl) }
                if reading.thread == nil || reading.joined {
                    ForEach(model.pending.values.filter { $0.threadId == thread.id && $0.state != "delivered" && thread.items["input:\($0.id)"] == nil }.sorted { $0.id < $1.id }) { row in
                        PendingSendRow(row: row, canRetry: model.canOperate) { await model.retrySend(row) }
                            .padding(.horizontal, AceTheme.Spacing.xl).padding(.vertical, AceTheme.Spacing.xs + AceTheme.Spacing.xxs)
                    }
                }
                // Room for the composer, its strip and the keyboard, and under the last row so it
                // clears the strip tucked above the composer. The feed itself never changes size as
                // they move: resizing a long lazy transcript re-estimates its height and throws the
                // scroll offset, so only this row grows and shrinks.
                Color.clear.frame(height: barHeight + keyboardLift + AceTheme.Spacing.xxl).accessibilityHidden(true)
                // The end of the feed: scrolling to it puts the room above at the bottom.
                TranscriptTail(thread: thread, following: pinned) { if !keyboardMoving { toEnd(proxy) } }
            }
            .padding(.top, AceTheme.Spacing.sm)
        }
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { feedBottom = $0 }
        .coordinateSpace(name: "transcript.viewport")
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .background(AceTheme.Colours.background)
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("transcript")
        .accessibilityValue(ready ? (reading.paged ? "Reading history" : "Ready") : "Loading")
        .onScrollPhaseChange { old, phase in
            switch phase {
            case .tracking:
                intent.begin()
            // A quick drag can skip tracking: a new gesture is one that starts from rest.
            case .interacting where old == .idle || old == .decelerating || old == .animating:
                intent.begin(); intent.active = true
            case .interacting, .decelerating: intent.active = true
            case .idle:
                // Only the person's own scroll decides whether the feed follows the end; the
                // feed's animated scrolls (the keyboard, the composer) settle while text streams.
                let touched = intent.active
                intent.active = false
                if touched, reading.thread == nil { following = intent.metrics.bottom <= AceTheme.Spacing.xxl }
            case .animating: break
            @unknown default: break
            }
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
            keepEnd(old: old, new: new, proxy: proxy)
            if thread.loaded, new.bottom <= 1 { ThreadOpenTrace.shared.settled(thread.id) }
            if intent.active {
                // Scrolling up only stops following: the live list stays in place until the
                // person nears its top, where the older page opens the reading window.
                if new.y < old.y - 1 { intent.direction = -1; following = false }
                else if new.y > old.y + 1 { intent.direction = 1 }
                pageIfNeeded(proxy)
            }
        }
        .onChange(of: acceptedSend) { _, _ in
            reading.live(model: model, thread: thread)
            following = true
            toEnd(proxy)
        }
        .onChange(of: reading.loading) { _, loading in if !loading { pageIfNeeded(proxy) } }
        .onChange(of: reading.revision) { _, _ in
            guard reading.thread != nil else { return }
            if let focus = reading.focus, let row = reading.thread?.screen.blockOrder.first(where: { reading.thread?.screen.blocks[$0]?.row.items.contains(focus) == true }) {
                reading.focus = nil
                proxy.scrollTo("block:\(row)", anchor: .center)
            } else { anchor.restore(with: proxy) }
        }
        .onChange(of: model.focusOnOpen, initial: true) { _, _ in focusRequested() }
        .onChange(of: thread.loaded) { _, loaded in
            if loaded, !initialScroll { toEnd(proxy); initialScroll = true }
            focusRequested()
        }
        .task {
            model.readingWillMove = {
                anchor.capture(viewport: intent.metrics.viewport, topInset: intent.metrics.topInset, bottomInset: intent.metrics.bottomInset)
            }
            model.readingMoved = { reading.moved() }
            if thread.loaded { toEnd(proxy); initialScroll = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            guard let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
            let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
            let lift = max(0, feedBottom - end.minY)
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
            roomChanged(by: new - old, motion: reduceMotion ? nil : AceTheme.Motion.standardCurve, proxy: proxy)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidChangeFrameNotification)) { _ in
            keyboardMoving = false
            // Text that streamed in while the keyboard moved.
            if pinned { toEnd(proxy) }
        }
        .onDisappear { reading.cancel(model: model); model.readingWillMove = nil; model.readingMoved = nil }
        .onChange(of: !following || reading.thread != nil, initial: true) { _, away in if behind != away { behind = away } }
        .onChange(of: jumps) { _, _ in
            reading.live(model: model, thread: thread)
            following = true
            toEnd(proxy)
        }
        .modifier(TranscriptTopEdge())
    }
    /// The room at the end changed (the keyboard, the composer or its strip). Following the end,
    /// the last row moves with it, in the same motion; reading elsewhere, the rows stay put and
    /// are covered, unless the smaller room would park the view past the end.
    private func roomChanged(by growth: CGFloat, motion: Animation?, proxy: ScrollViewProxy) {
        guard growth != 0, pinned || intent.metrics.bottom + growth < 0 else { return }
        // The room has its new height in this same update, so the end is where the scroll lands,
        // starting in the same frame as the keyboard.
        withAnimation(motion) { toEnd(proxy) }
    }
    private func toEnd(_ proxy: ScrollViewProxy) { proxy.scrollTo(TranscriptTail.id, anchor: .bottom) }
    /// A search hit asked for an item in this thread: the shared window opens around it.
    private func focusRequested() {
        guard thread.loaded, let focus = model.focusOnOpen, focus.thread == thread.id else { return }
        model.focusOnOpen = nil
        following = false
        reading.jump(to: focus.item, model: model, live: thread)
    }
    /// Following the end, the end stays in place as rows change height: older history filling in
    /// above, rows measured on the way down after a jump. The person's own scroll wins, and a
    /// change of room has its own animated scroll.
    private func keepEnd(old: TranscriptScrollIntent.Metrics, new: TranscriptScrollIntent.Metrics, proxy: ScrollViewProxy) {
        let room = barHeight + keyboardLift
        defer { intent.room = room }
        guard pinned, !intent.active, !keyboardMoving, room == intent.room,
              new.height != old.height, new.bottom > 1 else { return }
        toEnd(proxy)
    }
    private func pageIfNeeded(_ proxy: ScrollViewProxy) {
        guard intent.active, !intent.consumed, thread.loaded, !reading.loading, reading.problem == nil else { return }
        let ahead = max(AceTheme.Dimensions.touchTarget, intent.metrics.viewport * 1.5)
        if intent.direction < 0, intent.metrics.top < ahead, reading.thread == nil ? thread.screen.hasOlder : reading.hasOlder {
            intent.consumed = true
            reading.read("older", model: model, live: thread)
        } else if intent.direction > 0, intent.metrics.bottom < ahead, reading.thread != nil {
            intent.consumed = true
            if reading.joined, intent.metrics.bottom <= AceTheme.Spacing.xxl {
                reading.live(model: model, thread: thread); following = true; toEnd(proxy)
            } else if reading.hasNewer { reading.read("newer", model: model, live: thread) }
            else { intent.consumed = false }
        }
    }
}

/// The header's edge, as the web's border once content scrolls: on iOS 26 rows end crisply under
/// the bar instead of showing through it; before, the bar is opaque on the page colour.
private struct TranscriptTopEdge: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.scrollEdgeEffectStyle(.hard, for: .top)
        } else {
            content.toolbarBackground(AceTheme.Colours.background, for: .navigationBar)
                .toolbarBackgroundVisibility(.visible, for: .navigationBar)
        }
    }
}
