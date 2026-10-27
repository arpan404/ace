import SwiftUI

/// Gesture intent is consumed once per page; layout changes and programmatic scrolls never page.
private final class TranscriptScrollIntent {
    var active = false
    var consumed = false
    /// The room under the rows when the content height was last seen: a change of room scrolls
    /// itself, with the keyboard's or the composer's motion.
    var room: CGFloat = 0
    var direction = 0
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
    func begin() { active = true; consumed = false; direction = 0 }
}

/// Lazy rows measure themselves only as they come into view, so one scroll to the end can stop
/// short of it, or past it on an empty stretch where no row is drawn, when the rows it passed
/// turn out taller or shorter than estimated (or were swapped, leaving the history window). After
/// each scroll to the end this looks again every frame and scrolls once more until the end has
/// sat at the bottom for two frames, the person scrolls, or about half a second of looking has
/// passed. Frames spent waiting on an animated scroll don't count. VoiceOver moves the feed
/// without a drag the feed can see, so it is left alone there.
@MainActor private final class TranscriptEndSettle {
    private var task: Task<Void, Never>?
    /// `gap`: how far the end is from the bottom (negative past it), or nil to stop; `wait`: true
    /// while an animated scroll is still carrying the rows there.
    func run(gap: @escaping @MainActor () -> CGFloat?, wait: @escaping @MainActor () -> Bool, scroll: @escaping @MainActor () -> Void) {
        task?.cancel()
        guard !UIAccessibility.isVoiceOverRunning else { task = nil; return }
        task = Task<Void, Never> { @MainActor in
            var steady = 0, looks = 0, waits = 0
            while looks < 30, waits < 120 {
                do { try await Task.sleep(for: .milliseconds(16)) } catch { return }
                guard let gap = gap() else { return }
                if wait() { waits += 1; continue }
                looks += 1
                if abs(gap) <= 1 {
                    steady += 1
                    if steady == 2 { return }
                } else {
                    steady = 0
                    scroll()
                }
            }
        }
    }
    func cancel() { task?.cancel(); task = nil }
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
    /// Words taken back from a message that wasn't sent go into the composer.
    /// Words taken back go into the thread's saved draft; the take-back record is acknowledged once
    /// they are there.
    var restore: (String, String?) -> Void = { _, _ in }
    @State private var reading = TranscriptReading()
    @State private var following = true
    @State private var initialScroll = false
    @State private var intent = TranscriptScrollIntent()
    @State private var settle = TranscriptEndSettle()
    @State private var anchor = TranscriptReadingAnchor()
    /// How far the keyboard reaches above the feed's bottom edge.
    @State private var keyboardLift: CGFloat = 0
    /// While the keyboard moves, the live tail doesn't jump to the end on each delta: the
    /// keyboard's own animation carries the rows there.
    @State private var keyboardMoving = false
    /// The keyboard's last animation duration: the composer opens on the same spring as it.
    @State private var keyboardDuration = 0.35
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
                        PendingSendRow(row: row, canRetry: model.canOperate, retry: { await model.retrySend(row) },
                                       edit: {
                                           // The send's full words, once its dismissal is saved.
                                           let answer = await model.takeBackSend(row.id)
                                           guard let text = answer.text else { model.error = answer.message; return false }
                                           restore(text, answer.record)
                                           return true
                                       },
                                       discard: { await model.dismissSend(row.id) })
                            .padding(.horizontal, AceTheme.Spacing.xl).padding(.vertical, AceTheme.Spacing.xs + AceTheme.Spacing.xxs)
                    }
                    if let held = thread.screen.queue?.notSent {
                        HeldSendRow(message: held, canAct: model.canOperate, act: { await model.actOnQueue($0) },
                                    edit: { message, change in await model.editQueued(message, change: change) },
                                    words: { takeBack in await model.queuedWords(held.id, takeBack: takeBack) }, restore: restore)
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
                TranscriptTail(thread: thread, following: pinned) { if !keyboardMoving { toEnd(proxy) } }
            }
            .padding(.top, AceTheme.Spacing.sm)
            // A message that wasn't sent fades in and out where it was written.
            .animation(reduceMotion ? .easeInOut(duration: 0.2) : .smooth, value: thread.screen.queue?.notSent?.id)
            // A comfortable line on a wide window; the scroll itself stays full width.
            .frame(maxWidth: ReadingColumn.maxWidth)
            .frame(maxWidth: .infinity)
        }
        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { feedBottom = $0 }
        .coordinateSpace(name: "transcript.viewport")
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .background(AceTheme.Colours.background)
        .scrollDismissesKeyboard(.interactively)
        .modifier(TapPutsKeyboardAway(up: keyboardLift > 0))
        .accessibilityIdentifier("transcript")
        .accessibilityValue(ready ? (reading.paged ? "Reading history" : "Ready") : "Loading")
        .onScrollPhaseChange { old, phase in
            switch phase {
            case .tracking:
                settle.cancel()
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
                if reading.thread == nil { following = new.bottom <= AceTheme.Spacing.xxl }
            } else {
                keepEnd(old: old, new: new, proxy: proxy)
            }
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
        .onChange(of: shown.disclosures.opens) { _, _ in intent.opened = true }
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
            if pinned { toEnd(proxy) }
        }
        .onDisappear { settle.cancel(); reading.cancel(model: model); model.readingWillMove = nil; model.readingMoved = nil }
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
    private func toEnd(_ proxy: ScrollViewProxy) {
        proxy.scrollTo(TranscriptTail.id, anchor: .bottom)
        let intent = intent
        settle.run(gap: { pinned && !intent.active && !keyboardMoving ? intent.metrics.toEnd : nil },
                   wait: { intent.animating }) { proxy.scrollTo(TranscriptTail.id, anchor: .bottom) }
    }
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
        // Past the end is as wrong as short of it: there no row is drawn and the feed reads blank.
        guard pinned, !intent.active, !keyboardMoving, room == intent.room,
              new.height != old.height, abs(new.toEnd) > 1 else { return }
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
