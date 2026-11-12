import SwiftUI

/// One Spade conversation, live, or a new one (`conversationId` nil) that the first message
/// starts. The transcript keeps to its end while the person is there; the foot is the oldest
/// approval's strip over the composer capsule. A conversation Spade no longer has, or can't be
/// followed, says so with Try again.
struct SpadeConversationView: View {
    let model: ClientModel
    let conversationId: String?
    /// A new conversation started: where it is.
    var started: ((String) -> Void)? = nil
    @State private var draft = ""
    @State private var sending = false
    @State private var stopping = false
    @State private var problem: String?

    private var spade: SpadeModel { model.spade }
    private var shown: SpadeModel.Conversation? {
        guard let conversationId, let open = spade.conversation, open.id == conversationId else { return nil }
        return open
    }

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
        .navigationTitle(conversationId == nil ? "New conversation" : shown?.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            model.spadeWatch(true)
            if let conversationId { model.spadeOpen(conversationId) }
        }
        .onDisappear {
            model.spadeWatch(false)
            // Only this page's follow: the next page may already follow its own.
            if let conversationId, spade.opened == conversationId { model.spadeOpen(nil) }
        }
        // Stopping lasts until nothing is open: the reply and its background jobs.
        .onChange(of: shown?.busy) { _, busy in if busy != true { stopping = false } }
    }

    @ViewBuilder private var content: some View {
        let line = spade.line
        if conversationId == nil {
            if let line, !line.ready { quiet(line.sentence) }
        } else if let shown, let trouble = shown.problem {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text(trouble).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                    .foregroundStyle(AceTheme.StatusText.failed)
                Button("Try again") { model.spadeRetry() }.buttonStyle(.textAction(.prominent))
            }
            .accessibilityIdentifier("spade.problem")
        } else if let shown, shown.loaded {
            SpadeTranscript(spade: spade, conversation: shown, stopping: stopping, stop: stop)
        } else if line?.ready == false, let line {
            quiet(line.sentence)
        } else {
            SkeletonPage(label: "Loading conversation")
        }
    }

    @ViewBuilder private var foot: some View {
        VStack(spacing: AceDesign.Space.related) {
            if let approval = shown?.approval, let conversationId {
                SpadeApprovalStrip(approval: approval) { allowed, always in
                    let outcome = await model.spadeRequest(
                        ["type": "spade.answer", "conversationId": conversationId, "callId": approval.callId, "allowed": allowed, "always": always],
                        failing: "Couldn't answer Spade")
                    if !outcome.ok { problem = words(outcome) }
                    return outcome.ok
                }
                // Each approval is its own strip: the next one queued starts with its buttons on.
                .id(approval.callId)
            }
            if let problem {
                Text(problem).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.StatusText.failed)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, AceDesign.Space.margin)
                    .accessibilityIdentifier("spade.failure")
            }
            SpadeComposer(text: $draft, placeholder: placeholder, blocked: spade.line?.ready == true ? nil : spade.line?.sentence ?? "Checking Spade…",
                          sending: sending, send: send)
        }
        .padding(.horizontal, AceDesign.Space.row)
        .padding(.bottom, AceDesign.Space.related)
    }

    private var placeholder: String {
        conversationId == nil ? "Ask Spade anything" : shown?.answering == true ? "Steer Spade's reply" : "Message Spade"
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        // The field empties as the message goes; a message Spade refused comes back to it.
        draft = ""
        sending = true
        problem = nil
        Task {
            let outcome: SpadeOutcome
            if let conversationId {
                outcome = await model.spadeRequest(["type": "spade.send", "conversationId": conversationId, "text": text], failing: "Couldn't send to Spade")
            } else {
                outcome = await model.spadeRequest(["type": "spade.start", "text": text], failing: "Couldn't start the conversation")
            }
            sending = false
            if outcome.ok, let id = outcome.id { started?(id); return }
            if !outcome.ok {
                draft = SpadeDraft.restoring(text, into: draft)
                problem = words(outcome)
            }
        }
    }

    private func stop() {
        guard let conversationId else { return }
        stopping = true
        Task {
            let outcome = await model.spadeRequest(["type": "spade.stop", "conversationId": conversationId], failing: "Couldn't stop Spade")
            if !outcome.ok { stopping = false; problem = words(outcome) }
        }
    }

    private func words(_ outcome: SpadeOutcome) -> String? {
        let said = [outcome.title, outcome.message].compactMap(\.self).filter { !$0.isEmpty }
        return said.isEmpty ? nil : said.joined(separator: ". ")
    }

    private func quiet(_ text: String) -> some View {
        Text(text).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
            .foregroundStyle(AceDesign.Ink.muted)
            .accessibilityIdentifier("spade.state")
    }
}
