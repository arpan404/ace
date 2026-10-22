import SwiftUI

/// Gesture intent is consumed once per page; layout changes and programmatic scrolls never page.
private final class TranscriptScrollIntent {
    var active = false
    var consumed = false
    var direction = 0
    var metrics = Metrics(y: 0, top: 0, bottom: 0, viewport: 0, topInset: 0, bottomInset: 0)
    struct Metrics: Equatable { let y: CGFloat; let top: CGFloat; let bottom: CGFloat; let viewport: CGFloat; let topInset: CGFloat; let bottomInset: CGFloat }
    func begin() { active = true; consumed = false; direction = 0 }
}

/// One lazy reading column. Edge scrolling avoids List's stale collection-index scroll targets.
struct ConversationFeed: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let model: ClientModel
    let thread: ThreadModel
    let acceptedSend: Int
    let links: TranscriptLinks
    /// The composer and its strip, floating over the feed's bottom edge.
    var barHeight: CGFloat = 0
    @State private var reading = TranscriptReading()
    @State private var position = ScrollPosition(idType: String.self)
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
    private var shown: ThreadModel { reading.thread ?? thread.placeholder ?? thread }
    private var ready: Bool { thread.loaded || thread.placeholder != nil }
    private var pinned: Bool { following && reading.thread == nil }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                if reading.loading, reading.operation == "older" || reading.operation == "newer" {
                    Capsule().fill(AceTheme.Colours.fill).frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Spacing.sm)
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
                // Room for the composer, its strip and the keyboard. The feed itself never changes
                // size as they move: resizing a long lazy transcript re-estimates its height and
                // throws the scroll offset, so only this row grows and shrinks.
                Color.clear.frame(height: barHeight + keyboardLift).accessibilityHidden(true)
                TranscriptTail(thread: thread, following: pinned) { if !keyboardMoving { position.scrollTo(edge: .bottom) } }
            }
            .scrollTargetLayout()
            .padding(.top, AceTheme.Spacing.sm)
            // Room under the last row so it clears the composer strip tucked above the composer.
            .padding(.bottom, AceTheme.Spacing.xxl)
        }
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { feedBottom = $0 }
        .coordinateSpace(name: "transcript.viewport")
        .scrollPosition($position, anchor: .top)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .background(AceTheme.Colours.background)
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("transcript")
        .accessibilityValue(ready ? (reading.paged ? "Reading history" : "Ready") : "Loading")
        .onScrollPhaseChange { _, phase in
            switch phase {
            case .tracking:
                intent.begin()
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
            TranscriptScrollIntent.Metrics(y: geometry.contentOffset.y,
                top: geometry.contentOffset.y + geometry.contentInsets.top,
                bottom: geometry.contentSize.height + geometry.contentInsets.bottom - geometry.contentOffset.y - geometry.containerSize.height,
                viewport: geometry.containerSize.height, topInset: geometry.contentInsets.top, bottomInset: geometry.contentInsets.bottom)
        } action: { old, new in
            intent.metrics = new
            if intent.active {
                // Scrolling up only stops following: the live list stays in place until the
                // person nears its top, where the older page opens the reading window.
                if new.y < old.y - 1 { intent.direction = -1; following = false }
                else if new.y > old.y + 1 { intent.direction = 1 }
                pageIfNeeded()
            }
        }
        .onChange(of: acceptedSend) { _, _ in
            reading.live(model: model, thread: thread)
            following = true
            position.scrollTo(edge: .bottom)
        }
        .onChange(of: reading.loading) { _, loading in if !loading { pageIfNeeded() } }
        .onChange(of: reading.revision) { _, _ in
            if reading.thread != nil, reading.paged { anchor.restore(in: &position) }
        }
        .onChange(of: thread.loaded) { _, loaded in
            if loaded, !initialScroll { position.scrollTo(edge: .bottom); initialScroll = true }
        }
        .task {
            reading.willReplace = {
                anchor.capture(viewport: intent.metrics.viewport, topInset: intent.metrics.topInset, bottomInset: intent.metrics.bottomInset)
            }
            if thread.loaded { position.scrollTo(edge: .bottom); initialScroll = true }
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
            roomChanged(by: growth, motion: motion)
        }
        .onChange(of: barHeight) { old, new in
            roomChanged(by: new - old, motion: reduceMotion ? nil : AceTheme.Motion.standardCurve)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidChangeFrameNotification)) { _ in
            keyboardMoving = false
            // Text that streamed in while the keyboard moved.
            if pinned { position.scrollTo(edge: .bottom) }
        }
        .onDisappear { reading.cancel() }
        .overlay(alignment: .bottom) {
            if !following || reading.thread != nil {
                ScrollToEndPill {
                    reading.live(model: model, thread: thread)
                    following = true
                    position.scrollTo(edge: .bottom)
                }
                .padding(.bottom, AceTheme.Spacing.md + barHeight + keyboardLift)
                .transition(.opacity)
            }
        }
        .modifier(TranscriptTopEdge())
    }
    /// The room at the end changed (the keyboard, the composer or its strip). Following the end,
    /// the last row moves with it, in the same motion; reading elsewhere, the rows stay put and
    /// are covered, unless the smaller room would park the view past the end.
    private func roomChanged(by growth: CGFloat, motion: Animation?) {
        let metrics = intent.metrics
        guard growth != 0, pinned || metrics.bottom + growth < 0 else { return }
        // The new end, from where the view is now: known before the room is laid out, so the
        // scroll starts in the same frame as the keyboard. Scroll positions count from the top
        // of the content, below the top inset.
        let end = max(0, metrics.top + metrics.bottom + growth)
        withAnimation(motion) { position.scrollTo(y: end) }
    }
    private func pageIfNeeded() {
        guard intent.active, !intent.consumed, thread.loaded, !reading.loading, reading.problem == nil else { return }
        let ahead = max(AceTheme.Dimensions.touchTarget, intent.metrics.viewport * 1.5)
        if intent.direction < 0, intent.metrics.top < ahead, reading.thread == nil ? thread.screen.hasOlder : reading.hasOlder {
            intent.consumed = true
            reading.read("older", model: model, live: thread)
        } else if intent.direction > 0, intent.metrics.bottom < ahead, reading.thread != nil {
            intent.consumed = true
            if reading.joined, intent.metrics.bottom <= AceTheme.Spacing.xxl {
                reading.live(model: model, thread: thread); following = true; position.scrollTo(edge: .bottom)
            } else if reading.hasNewer { reading.read("newer", model: model, live: thread) }
            else { intent.consumed = false }
        }
    }
}

/// Back to the live end, as the web's: a pill centred over the composer, "Scroll to end".
private struct ScrollToEndPill: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                AceIcon(.caretDown, size: 13, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                Text("Scroll to end").fontWeight(.medium).foregroundStyle(AceTheme.Colours.foreground)
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .padding(.leading, AceTheme.Spacing.md).padding(.trailing, AceTheme.Spacing.md + AceTheme.Spacing.xxs)
            .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.xs)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .aceGlass(in: Capsule(), interactive: true)
        .accessibilityIdentifier("transcript.latest")
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
