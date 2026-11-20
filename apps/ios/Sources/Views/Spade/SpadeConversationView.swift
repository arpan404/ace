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
            transcript
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
                    SpadeFaceView(face: face, size: AceDesign.Size.barIcon + AceDesign.Space.related,
                                  moving: head?.working?.moving == true)
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
        let key = spade.order.first { key in
            if case let .question(card) = spade.bubbles[key] { card.callId == callId } else { false }
        }
        if let key { withAnimation { reader.scrollTo(key, anchor: .center) } }
    }

    private var transcript: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: AceDesign.Space.related) {
                ForEach(spade.order, id: \.self) { key in
                    if let bubble = spade.bubbles[key] {
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
        }
        // On the transcript only: set below the composer's inset, it would replace the
        // composer's and Stop's own identifiers.
        .accessibilityIdentifier("spade.conversation")
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .overlay { if head?.loaded != true && spade.order.isEmpty { SkeletonRows(count: 3) } }
        .safeAreaInset(edge: .bottom) { composer }
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

    private func problemLine(_ text: String) -> some View {
        // ProblemRow keeps a list's margin; the transcript already has it.
        ProblemRow(text, id: "spade.conversationProblem") { client.spadeRetry() }
            .padding(.horizontal, -AceDesign.Space.margin)
            .padding(.top, AceDesign.Space.related)
    }

    private var typed: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private var composer: some View {
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
                trailing
            }
            .padding(AceDesign.Space.tight)
            .aceGlass(in: AceDesign.Shape.field, interactive: true)
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.bottom, AceDesign.Space.related)
        }
    }

    /// Send once something is typed (a message steers an open reply); Stop while one is open.
    @ViewBuilder private var trailing: some View {
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
            Button { send() } label: {
                Image(systemName: "arrow.up")
                    .font(AceDesign.Typeface.body.weight(AceDesign.Typeface.strong))
                    .foregroundStyle(AceDesign.Surface.background)
                    .frame(width: AceDesign.Size.navButton, height: AceDesign.Size.navButton)
                    .background(typed ? AceDesign.Ink.accent : AceDesign.Ink.faint, in: Circle())
            }
            .disabled(!typed)
            .accessibilityLabel("Send")
            .accessibilityIdentifier("spade.send")
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        problem = nil
        sends += 1
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
                    SpadeFaceView(face: face, size: AceDesign.Size.barIcon + AceDesign.Space.tight, moving: working.moving)
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
