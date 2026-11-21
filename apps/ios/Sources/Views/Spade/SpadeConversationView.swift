import SwiftUI

/// One bot's conversation (docs/design/spade.md §3), as a messenger: the bot's bubbles on the
/// left, the person's on the right in the accent, an approval as a raised card where it was
/// asked, the working line under the last bubble while the bot works, and the composer at the
/// foot: Send once something is typed, Stop while a reply is open. The bot's face and name head
/// it, and open its profile. A group's (ADR 0132) is the same chat with each member's face and
/// name, its members' faces at the top, and a waiting member's chat one tap away. Everything
/// is the bridge's.
struct SpadeConversationView: View {
    let client: ClientModel
    let conversation: String
    /// The group whose conversation this is; nil for a bot's.
    var group: String?
    /// Opens another conversation over this one: a waiting member's own chat.
    var open: (SpadeRoute) -> Void = { _ in }
    @State private var draft = ""
    @State private var problem: String?
    @State private var sends = 0
    @State private var stops = 0
    /// Cards for later opened from their line or the top bar's count.
    @State private var unfolded: Set<String> = []
    @FocusState private var typing: Bool
    @State private var profileShown = false
    /// Whether the chat keeps its end on screen (`ChatEndFollow`): only while the person is there.
    @State private var follow = ChatEndFollow(slack: Double(AceDesign.Space.group))
    /// Where the scroll is and which stack holds the rows, kept where writing them redraws nothing.
    @State private var scroll = SpadeScroll()
    /// Bumped when the rows move to the other stack, to lay them out again in it.
    @State private var stackSwitches = 0
    /// The end of the chat: scrolling it to the bottom shows the last bubble over the composer.
    private static let endID = "spade.end"

    private var spade: SpadeModel { client.spade }
    private var head: SpadeModel.Conversation? {
        spade.conversation?.id == conversation ? spade.conversation : nil
    }
    /// The bot, or the group, as the list has it.
    private var bot: SpadeModel.Bot? {
        spade.bots?.first { $0.conversation == conversation && $0.group == group }
    }
    private var name: String { bot?.name ?? HomeTabs.title(.spade) }

    var body: some View {
        ScrollViewReader { reader in
            transcript(reader)
                .toolbar {
                    ToolbarItem(placement: .principal) { titleButton }
                    if let later = head?.later {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button(later.words) { reach(later.callId, with: reader) }
                                .accessibilityIdentifier("spade.forLater")
                        }
                    }
                }
        }
    }

    /// The face and name at the top. A bot's open its profile, as a contact's do in Messages; a
    /// group's show its members.
    @ViewBuilder private var titleButton: some View {
        let title = HStack(spacing: AceDesign.Space.related) {
            if let bot {
                if bot.group != nil { SpadeGroupFaces(faces: bot.faces, size: AceDesign.Size.barIcon + AceDesign.Space.related) }
                else if let face = bot.faces.first {
                    let titlePose: BotFacePose = head?.working.map { $0.moving ? .working : .needsYou } ?? .idle
                    SpadeFaceView(face: face, size: AceDesign.Size.barIcon + AceDesign.Space.related, pose: titlePose)
                }
            }
            Text(name).aceFont(AceDesign.TextRole.navTitle).foregroundStyle(AceDesign.Ink.primary).lineLimit(1)
        }
        if group == nil, bot != nil {
            Button { profileShown = true } label: { title }
                .accessibilityLabel("\(name), profile")
                .accessibilityIdentifier("spade.profile")
        } else {
            title.accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
        }
    }

    /// The top bar's "questions for later" goes to the oldest such card, open.
    private func reach(_ callId: String, with reader: ScrollViewProxy) {
        unfolded.insert(callId)
        follow.jumped()
        let key = spade.order.first { key in
            if case let .question(card) = spade.bubbles[key] { card.callId == callId } else { false }
        }
        if let key { withAnimation { reader.scrollTo(key, anchor: .center) } }
    }

    private func transcript(_ reader: ScrollViewProxy) -> some View {
        // A plain stack for a short chat, so no row's height is a guess that corrects itself on
        // screen; a lazy one past `TranscriptStackChoice`'s limit, as the thread's transcript.
        let _ = stackSwitches
        let stack: TranscriptStackChoice.Stack = spade.order.isEmpty ? .lazy : scroll.stack.opened(rows: spade.order.count)
        return ScrollView {
            VStack(spacing: AceTheme.Spacing.none) {
                TranscriptRowsStack(stack: stack, spacing: AceDesign.Space.related) {
                    ForEach(spade.order, id: \.self) { key in
                        if case let .workers(workers) = spade.bubbles[key] {
                            SpadeWorkersCard(workers: workers, client: client) { open(SpadeRoute(conversation: $0, group: nil)) }
                                .id(key)
                        } else if let bubble = spade.bubbles[key] {
                            SpadeBubbleView(bubble: bubble, answer: { callId, allowed, always in
                                await answer(callId, allowed: allowed, always: always)
                            }, unfolded: unfolded, fold: { callId, open in
                                if open { unfolded.insert(callId) } else { unfolded.remove(callId) }
                            }, reply: { callId, body in
                                await spade.cards.send(conversation, callId: callId, readBack: {
                                    await client.spadeQuestionRead(conversation, callId: callId)
                                }) {
                                    await client.spadeQuestion(conversation, callId: callId, reply: body)
                                }
                            }, sending: { spade.cards.isSending(conversation, callId: $0) }, drafts: { callId in
                                Binding(get: { spade.cards.drafts(conversation, callId: callId) ?? [] },
                                        set: { spade.cards.keep($0, conversation: conversation, callId: callId) })
                            })
                            .id(key)
                        }
                    }
                    if let working = head?.working {
                        SpadeWorkingLine(working: working, waiting: head?.waiting) { open(SpadeRoute(conversation: $0, group: nil)) }
                    }
                    if let gone = head?.problem { problemLine(gone) }
                }
                .padding(.horizontal, AceDesign.Space.margin)
                .padding(.vertical, AceDesign.Space.row)
                Color.clear.frame(height: AceTheme.Spacing.none).id(Self.endID).accessibilityHidden(true)
            }
        }
        // On the transcript only: set below the composer's inset, it would replace the
        // composer's and Stop's own identifiers.
        .accessibilityIdentifier("spade.conversation")
        // Opens at the end, and a short chat sits on the composer. Size changes (a streaming
        // reply, rows measuring, the keyboard, the composer growing) keep the bottom still only
        // while the chat follows its end; reading back, the rows on screen stay where they are.
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(follow.following ? .bottom : nil, for: .sizeChanges)
        .defaultScrollAnchor(.bottom, for: .alignment)
        .onScrollGeometryChange(for: SpadeScroll.Place.self) { geometry in
            let insets = geometry.contentInsets
            return SpadeScroll.Place(y: geometry.contentOffset.y,
                fromEnd: ScrollEnd.fromEnd(contentHeight: geometry.contentSize.height, offsetY: geometry.contentOffset.y,
                                           containerHeight: geometry.containerSize.height, topInset: insets.top),
                viewport: geometry.containerSize.height + insets.top + insets.bottom,
                contentHeight: geometry.contentSize.height)
        } action: { old, new in
            scroll.place = new
            if Int(new.contentHeight) != Int(old.contentHeight) {
                SpadeFeedTrace.laidOut(contentHeight: new.contentHeight, viewport: new.viewport, rows: spade.order.count)
            }
            if new.y < old.y - 1 { change { $0.scrolled(towardOlder: true) } }
        }
        .onScrollPhaseChange { _, phase in scrollPhase(phase) }
        .onChange(of: spade.order.count) { restack() }
        .scrollDismissesKeyboard(.interactively)
        .overlay { if head?.loaded != true && spade.order.isEmpty { SkeletonRows(count: 3) } }
        .safeAreaInset(edge: .bottom) { composer(reader) }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $profileShown) {
            if let bot { SpadeProfileSheet(client: client, agent: bot.id, name: bot.name) }
        }
        .background(AceDesign.Surface.background)
        .sensoryFeedback(AceDesign.Haptic.send, trigger: sends)
        .sensoryFeedback(AceDesign.Haptic.stop, trigger: stops)
        .onAppear { client.spadeOpen(conversation, group: group) }
        .onDisappear { if client.spade.opened == conversation { client.spadeOpen(nil) } }
    }

    /// The person's scroll starts, moves on its own after the finger, or comes to rest.
    private func scrollPhase(_ phase: ScrollPhase) {
        switch phase {
        case .tracking, .interacting:
            scroll.moving = true
            change { $0.touched() }
        case .decelerating, .animating:
            scroll.moving = true
        case .idle:
            scroll.moving = false
            change { $0.rested(fromEnd: scroll.place.fromEnd, viewport: scroll.place.viewport) }
            restack()
        @unknown default:
            break
        }
    }

    /// Writes the follow state only when it changes, so a scroll's frames redraw nothing.
    private func change(_ step: (inout ChatEndFollow) -> Void) {
        var next = follow
        step(&next)
        if next != follow { follow = next }
    }

    /// Moves the rows to the other stack when the chat outgrew a plain one, never mid-scroll.
    private func restack() {
        if scroll.stack.update(rows: spade.order.count, moving: scroll.moving) != nil { stackSwitches += 1 }
    }

    private func problemLine(_ text: String) -> some View {
        // ProblemRow keeps a list's margin; the transcript already has it.
        ProblemRow(text, id: "spade.conversationProblem") { client.spadeRetry() }
            .padding(.horizontal, -AceDesign.Space.margin)
            .padding(.top, AceDesign.Space.related)
    }

    private var typed: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func composer(_ reader: ScrollViewProxy) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            if let problem {
                Text(problem)
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceTheme.StatusText.failed)
                    .padding(.horizontal, AceDesign.Space.margin)
                    .accessibilityIdentifier("spade.problem")
            }
            HStack(alignment: .bottom, spacing: AceDesign.Space.related) {
                TextField("Message \(name)", text: $draft, axis: .vertical)
                    .aceFont(AceDesign.TextRole.message)
                    .lineLimit(1...6)
                    .focused($typing)
                    .padding(.horizontal, AceDesign.Space.margin)
                    .padding(.vertical, AceDesign.Space.related)
                    .accessibilityIdentifier("spade.composer")
                trailing(reader)
            }
            .padding(AceDesign.Space.tight)
            .aceGlass(in: AceDesign.Shape.field, interactive: true)
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.bottom, AceDesign.Space.related)
        }
    }

    /// Send once something is typed (a message steers an open reply); Stop while one is open.
    @ViewBuilder private func trailing(_ reader: ScrollViewProxy) -> some View {
        if !typed && head?.answering == true {
            Button { stop() } label: {
                RoundedRectangle(cornerRadius: AceDesign.Corner.glyphStop)
                    .frame(width: AceDesign.Size.stopGlyph, height: AceDesign.Size.stopGlyph)
                    .foregroundStyle(AceDesign.Surface.background)
                    .frame(width: AceDesign.Size.navButton, height: AceDesign.Size.navButton)
                    .background(AceDesign.Ink.accent, in: Circle())
            }
            .accessibilityLabel("Stop")
            .accessibilityIdentifier("spade.stop")
        } else {
            Button { send(reader) } label: {
                AceIcon(.arrowUp, size: AceDesign.Size.icon, relativeTo: .body)
                    .foregroundStyle(AceDesign.Surface.background)
                    .frame(width: AceDesign.Size.navButton, height: AceDesign.Size.navButton)
                    .background(typed ? AceDesign.Ink.accent : AceDesign.Ink.faint, in: Circle())
            }
            .disabled(!typed)
            .accessibilityLabel("Send")
            .accessibilityIdentifier("spade.send")
        }
    }

    private func send(_ reader: ScrollViewProxy) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        problem = nil
        sends += 1
        // What the person sent shows at the end, wherever they were reading.
        follow.sent()
        withAnimation { reader.scrollTo(Self.endID, anchor: .bottom) }
        Task {
            let outcome: SpadeOutcome
            if let group { outcome = await client.spadeGroupSend(group, conversation: conversation, text: text) }
            else { outcome = await client.spadeSend(conversation, text: text) }
            guard !outcome.ok else { return }
            // Refused: the words come back, before anything typed while it was out.
            draft = SpadeDraft.restoring(text, into: draft)
            problem = outcome.problem
        }
    }

    private func stop() {
        stops += 1
        Task {
            if let group { problem = await client.spadeGroupStop(group).problem }
            else { problem = await client.spadeStop(conversation).problem }
        }
    }

    private func answer(_ callId: String, allowed: Bool, always: Bool) async -> Bool {
        let outcome = await client.spadeAnswer(conversation, callId: callId, allowed: allowed, always: always)
        problem = outcome.problem
        return outcome.ok
    }
}

/// Under the last bubble while the bot works: what it is doing, moving only while it works
/// itself, still while it waits on the person. In a group, the member answering's face leads
/// it, and a member waiting on the person offers its own chat, where the question is.
private struct SpadeWorkingLine: View {
    let working: SpadeModel.Working
    var waiting: SpadeModel.Waiting?
    var open: (String) -> Void = { _ in }
    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            HStack(spacing: AceDesign.Space.related) {
                if let face = working.face {
                    SpadeFaceView(
                        face: face,
                        size: AceDesign.Size.barIcon + AceDesign.Space.tight,
                        pose: working.moving ? .working : .needsYou
                    )
                } else if working.moving { WorkingMark(label: working.label) } else {
                    StatusGlyph(.needsYou, tone: .needsYou, size: AceDesign.Size.icon)
                }
                Text(working.label).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("spade.working")
            if let waiting {
                Button("Open \(waiting.name)") { open(waiting.conversation) }
                    .aceFont(AceDesign.TextRole.meta)
                    .accessibilityIdentifier("spade.openWaiting")
            }
        }
        .padding(.top, AceDesign.Space.related)
    }
}

/// Spade's scroll as last reported, and the stack its rows are in. A class nothing observes, so
/// writing it on each scroll frame never redraws the chat.
@MainActor private final class SpadeScroll {
    struct Place: Equatable {
        var y: Double = 0
        /// How far the end is below the bottom edge (`ScrollEnd`).
        var fromEnd: Double = 0
        var viewport: Double = 0
        /// The rows' laid-out height, for `SpadeFeedTrace`.
        var contentHeight: Double = 0
    }
    var place = Place()
    /// A finger, its fling or an animated scroll is moving the chat.
    var moving = false
    var stack = TranscriptStackChoice()
}
