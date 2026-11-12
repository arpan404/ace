import SwiftUI

/// One bot's one conversation, live (ADR 0126, 0127). The chat keeps to its end while the person
/// is there; the foot is the composer capsule. A conversation Spade no longer has, or can't be
/// followed, says so with Try again.
struct SpadeConversationView: View {
    let model: ClientModel
    let bot: SpadeModel.Opened
    @State private var draft = ""
    @State private var sending = false
    @State private var stopping = false
    @State private var problem: String?

    private var spade: SpadeModel { model.spade }
    private var shown: SpadeModel.Conversation? {
        guard let open = spade.conversation, open.agentId == bot.agentId else { return nil }
        return open
    }
    private var row: SpadeModel.Bot? { spade.bot(bot.agentId) }

    var body: some View {
        ScrollView {
            content
                .padding(.horizontal, AceDesign.Space.margin)
                .padding(.vertical, AceDesign.Space.section)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) { foot }
        .background(AceTheme.Colours.background)
        .navigationTitle(row?.name ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            model.spadeWatch(true)
            model.spadeOpen(bot)
        }
        .onDisappear {
            model.spadeWatch(false)
            // Only this page's follow: the next page may already follow its own.
            if spade.opened == bot { model.spadeOpen(nil) }
        }
        // Stopping lasts until nothing is open: the reply and its background work.
        .onChange(of: shown?.busy) { _, busy in if busy != true { stopping = false } }
    }

    @ViewBuilder private var content: some View {
        let line = spade.line
        if let shown, let trouble = shown.problem {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text(trouble).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                    .foregroundStyle(AceTheme.StatusText.failed)
                Button("Try again") { model.spadeRetry() }.buttonStyle(.textAction(.prominent))
            }
            .accessibilityIdentifier("spade.problem")
        } else if let shown, shown.loaded {
            if spade.order.isEmpty, shown.status == nil {
                Text("No messages yet").aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                    .foregroundStyle(AceDesign.Ink.muted)
            }
            SpadeChat(model: model, bot: row, conversation: shown, stopping: stopping, stop: stop, answer: answer,
                      retry: { words in send(words) })
        } else if line?.ready == false, let line {
            Text(line.sentence).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                .foregroundStyle(AceDesign.Ink.muted)
                .accessibilityIdentifier("spade.state")
        } else {
            SkeletonPage(label: "Loading conversation")
        }
    }

    private var foot: some View {
        VStack(spacing: AceDesign.Space.related) {
            if let problem {
                Text(problem).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.StatusText.failed)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, AceDesign.Space.margin)
                    .accessibilityIdentifier("spade.failure")
            }
            SpadeComposer(text: $draft, placeholder: "Message \(row?.name ?? "Spade")",
                          blocked: spade.line?.ready == true ? nil : spade.line?.sentence ?? "Checking Spade…",
                          sending: sending, send: { send(nil) })
        }
        .padding(.horizontal, AceDesign.Space.row)
        .padding(.bottom, AceDesign.Space.related)
    }

    /// Sends the composer's words, or `again` (a failed reply's Try again). While a reply is
    /// open the message steers it; Spade decides, never the phone.
    private func send(_ again: String?) {
        let text = (again ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        // The field empties as the message goes; a message Spade refused comes back to it.
        if again == nil { draft = "" }
        sending = true
        problem = nil
        Task {
            let outcome = await model.spadeRequest(["type": "spade.send", "conversationId": bot.conversationId, "text": text],
                                                   failing: "Couldn't send it")
            sending = false
            if outcome.ok { return }
            let after = SpadeDraft.after(outcome, sent: text, draft: draft)
            draft = after.draft
            problem = after.problem
        }
    }

    private func answer(_ callId: String, _ allowed: Bool, _ always: Bool) async -> Bool {
        let outcome = await model.spadeRequest(
            ["type": "spade.answer", "conversationId": bot.conversationId, "callId": callId, "allowed": allowed, "always": always],
            failing: "Couldn't answer it")
        if !outcome.ok { problem = outcome.words }
        return outcome.ok
    }

    private func stop() {
        stopping = true
        Task {
            let outcome = await model.spadeRequest(["type": "spade.stop", "conversationId": bot.conversationId], failing: "Couldn't stop it")
            if !outcome.ok { stopping = false; problem = outcome.words }
        }
    }
}
