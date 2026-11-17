import SwiftUI

/// One bot's conversation (docs/design/spade.md §3), as a messenger: the bot's bubbles on the
/// left, the person's on the right in the accent, an approval as a raised card where it was
/// asked, the working line under the last bubble while the bot works, and the composer at the
/// foot: Send once something is typed, Stop while a reply is open. Everything is the bridge's.
struct SpadeConversationView: View {
    let client: ClientModel
    let conversation: String
    @State private var draft = ""
    @State private var problem: String?
    @State private var sends = 0
    @State private var stops = 0
    @FocusState private var typing: Bool

    private var spade: SpadeModel { client.spade }
    private var head: SpadeModel.Conversation? {
        spade.conversation?.id == conversation ? spade.conversation : nil
    }
    private var bot: SpadeModel.Bot? { spade.bots?.first { $0.conversation == conversation } }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: AceDesign.Space.related) {
                ForEach(spade.order, id: \.self) { key in
                    if let bubble = spade.bubbles[key] {
                        SpadeBubbleView(bubble: bubble) { callId, allowed, always in
                            await answer(callId, allowed: allowed, always: always)
                        }
                        .id(key)
                    }
                }
                if let working = head?.working { SpadeWorkingLine(working: working) }
                if let gone = head?.problem { problemLine(gone) }
            }
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.vertical, AceDesign.Space.row)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .overlay { if head?.loaded != true && spade.order.isEmpty { SkeletonRows(count: 3) } }
        .safeAreaInset(edge: .bottom) { composer }
        .navigationTitle(bot?.name ?? HomeTabs.title(.spade))
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(.hidden, for: .tabBar)
        .background(AceDesign.Surface.background)
        .sensoryFeedback(AceDesign.Haptic.send, trigger: sends)
        .sensoryFeedback(AceDesign.Haptic.stop, trigger: stops)
        .onAppear { client.spadeOpen(conversation) }
        .onDisappear { if client.spade.opened == conversation { client.spadeOpen(nil) } }
        .accessibilityIdentifier("spade.conversation")
    }

    private func problemLine(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text(text).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.failed)
            Button("Try again") { client.spadeRetry() }.buttonStyle(.textAction(.prominent))
        }
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
                TextField("Message \(bot?.name ?? HomeTabs.title(.spade))", text: $draft, axis: .vertical)
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
            let outcome = await client.spadeSend(conversation, text: text)
            guard !outcome.ok else { return }
            // Refused: the words come back, before anything typed while it was out.
            draft = SpadeDraft.restoring(text, into: draft)
            problem = outcome.problem
        }
    }

    private func stop() {
        stops += 1
        Task { problem = await client.spadeStop(conversation).problem }
    }

    private func answer(_ callId: String, allowed: Bool, always: Bool) async -> Bool {
        let outcome = await client.spadeAnswer(conversation, callId: callId, allowed: allowed, always: always)
        problem = outcome.problem
        return outcome.ok
    }
}

/// Under the last bubble while the bot works: what it is doing, moving only while it works
/// itself, still while it waits on the person.
private struct SpadeWorkingLine: View {
    let working: SpadeModel.Working
    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            if working.moving { WorkingMark(label: working.label) } else {
                StatusGlyph(.needsYou, tone: .needsYou, size: AceDesign.Size.icon)
            }
            Text(working.label).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
        }
        .padding(.top, AceDesign.Space.related)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("spade.working")
    }
}
