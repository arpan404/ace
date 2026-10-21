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
    let model: ClientModel
    let thread: ThreadModel
    let acceptedSend: Int
    let links: TranscriptLinks
    @State private var reading = TranscriptReading()
    @State private var position = ScrollPosition(idType: String.self)
    @State private var following = true
    @State private var initialScroll = false
    @State private var intent = TranscriptScrollIntent()
    @State private var anchor = TranscriptReadingAnchor()
    private var shown: ThreadModel { reading.thread ?? thread.placeholder ?? thread }
    private var ready: Bool { thread.loaded || thread.placeholder != nil }

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
                TranscriptTail(thread: thread, following: following && reading.thread == nil) { position.scrollTo(edge: .bottom) }
            }
            .scrollTargetLayout()
            .padding(.top, AceTheme.Spacing.sm)
            // Room for the live capsule and jump control floating above the composer.
            .padding(.bottom, AceTheme.Dimensions.touchTarget + AceTheme.Spacing.xl)
        }
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
                intent.active = false
                if reading.thread == nil { following = intent.metrics.bottom <= AceTheme.Spacing.xxl }
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
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
            // A transcript shorter than the space left stays put; scrolling it to the bottom
            // while the insets animate would leave it above the view.
            let overflows = intent.metrics.top + intent.metrics.bottom > AceTheme.Dimensions.border
            if following && reading.thread == nil && overflows { position.scrollTo(edge: .bottom) }
        }
        .onDisappear { reading.cancel() }
        .overlay(alignment: .bottomTrailing) {
            if !following || reading.thread != nil {
                GlassIconButton(systemImage: "arrow.down", label: "Jump to latest", size: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.xs) {
                    reading.live(model: model, thread: thread)
                    following = true
                    position.scrollTo(edge: .bottom)
                }
                .accessibilityIdentifier("transcript.latest")
                .padding(.trailing, AceTheme.Spacing.xl).padding(.bottom, AceTheme.Spacing.md)
                .transition(.opacity)
            }
        }
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
