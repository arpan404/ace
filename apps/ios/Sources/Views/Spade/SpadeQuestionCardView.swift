import SwiftUI

/// A card of questions a bot asks (ADR 0154), where it asked. Waiting on the person it is raised:
/// one question at a time (‹ 1 of 2 › between them, answers kept across them), Answer later and
/// Never mind as quiet words, and Next, or Send on the last, as the one primary. A lone yes-or-no
/// question is answered by Yes and No themselves. Left for later it folds to one line with
/// Answer, which opens it (Answer later folds it back). Settled, its questions read as the bot's
/// quiet bubbles and the answers as the person's. What counts as an answer is the bridge's.
struct SpadeQuestionCardView: View {
    let card: SpadeQuestionCard
    /// A card for later shows open: opened from its line or from the top bar's count.
    let unfolded: Bool
    /// Its reply is out and Spade hasn't settled it: locked, wherever it is drawn
    /// (`SpadeModel.send`).
    let sending: Bool
    let fold: (Bool) -> Void
    let reply: ([String: Any]) async -> SpadeOutcome

    var body: some View {
        switch card.standing {
        case .later where !unfolded: laterLine
        case .open, .later:
            SpadeOpenQuestionCard(card: card, sending: sending, fold: card.standing == .later ? { fold(false) } : nil, reply: reply)
        case .settled: settled
        }
    }

    private var laterLine: some View {
        HStack(spacing: AceDesign.Space.related) {
            AceIcon(.clock, size: AceDesign.Size.glyphMeta, relativeTo: .footnote)
                .foregroundStyle(AceDesign.Ink.subtle)
            Text("For later · \(card.questions.count == 1 ? card.questions[0].prompt : "\(card.questions.count) questions")")
                .aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(AceDesign.Ink.muted)
                .lineLimit(1)
            Spacer(minLength: AceDesign.Space.related)
            Button("Answer") { fold(true) }
                .buttonStyle(.textAction(.prominent))
                .accessibilityIdentifier("spade.question.answer")
        }
        .frame(minHeight: AceDesign.Size.tap)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(card.label)
        .accessibilityIdentifier("spade.question.folded")
    }

    @ViewBuilder private var settled: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            if let answers = card.answers {
                ForEach(Array(card.questions.enumerated()), id: \.offset) { at, question in
                    SpadeQuietBubble(text: question.prompt)
                    if at < answers.count, let answer = answers[at] { SpadeAnswerBubble(text: answer) }
                }
            } else {
                SpadeQuietBubble(text: card.questions.map(\.prompt).joined(separator: "\n\n"))
                if let line = card.line {
                    Text(line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.subtle)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("spade.question.settled")
    }
}

/// A question the bot asked, as its bubble once settled: quiet, on the page's fill.
private struct SpadeQuietBubble: View {
    let text: String
    var body: some View {
        AceMarkdown(text: text, streaming: false)
            .foregroundStyle(AceDesign.Ink.muted)
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.vertical, AceDesign.Space.related)
            .background(AceDesign.Surface.fill, in: AceDesign.Shape.bubble)
            .padding(.trailing, AceDesign.Space.section)
    }
}

/// An answer, as the person's own bubble.
private struct SpadeAnswerBubble: View {
    let text: String
    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            Spacer(minLength: UserBubble.inset)
            Text(text)
                .aceFont(AceDesign.TextRole.message)
                .foregroundStyle(AceDesign.Surface.background)
                .padding(.horizontal, AceDesign.Space.margin)
                .padding(.vertical, AceDesign.Space.related)
                .background(AceDesign.Ink.accent, in: AceDesign.Shape.bubble)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You: \(text)")
    }
}

private struct SpadeOpenQuestionCard: View {
    let card: SpadeQuestionCard
    let sending: Bool
    /// A card already for later folds back to its line instead of being left for later again.
    let fold: (() -> Void)?
    let reply: ([String: Any]) async -> SpadeOutcome
    @State private var drafts: [SpadeQuestionCard.Draft] = []
    @State private var page = 0
    @State private var problem: String?
    @State private var answered = 0

    private var count: Int { card.questions.count }
    private var at: Int { min(page, max(count - 1, 0)) }
    private var loneConfirm: Bool { count == 1 && card.questions.first?.kind == "confirm" }

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.row) {
            if card.questions.indices.contains(at) {
                let question = card.questions[at]
                HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                    StatusGlyph(.needsYou, tone: .needsYou, size: AceDesign.Size.icon)
                    RequestHeader(title: question.prompt)
                    if count > 1 { pager }
                }
                if !loneConfirm {
                    SpadeQuestionInputs(question: question, draft: draftBinding(at))
                        .disabled(sending)
                        .id(at)
                }
            }
            if let problem {
                Text(problem)
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceTheme.StatusText.failed)
                    .accessibilityIdentifier("spade.question.problem")
            }
            footer
        }
        .padding(AceDesign.Space.margin)
        .background(AceDesign.Surface.raised, in: AceDesign.Shape.container)
        .floatingShadow()
        .sensoryFeedback(AceDesign.Haptic.approve, trigger: answered)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(card.label)
        .accessibilityIdentifier("spade.question")
        .onAppear { if drafts.count != count { drafts = card.questions.map(SpadeQuestionCard.Draft.empty) } }
    }

    private func draftBinding(_ index: Int) -> Binding<SpadeQuestionCard.Draft> {
        Binding(
            get: { drafts.indices.contains(index) ? drafts[index] : .empty(for: card.questions[index]) },
            set: { next in
                if drafts.count != count { drafts = card.questions.map(SpadeQuestionCard.Draft.empty) }
                drafts[index] = next
                problem = nil
            })
    }

    private var pager: some View {
        HStack(spacing: AceDesign.Space.tight) {
            Button { page = at - 1; problem = nil } label: { AceIcon(.caretLeft, size: AceDesign.Size.glyphSmall, relativeTo: .caption) }
                .disabled(at == 0)
                .accessibilityLabel("Previous question")
            Text("\(at + 1) of \(count)")
                .aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(AceDesign.Ink.muted)
                .monospacedDigit()
            Button { page = at + 1; problem = nil } label: { AceIcon(.caretRight, size: AceDesign.Size.glyphSmall, relativeTo: .caption) }
                .disabled(at >= count - 1)
                .accessibilityLabel("Next question")
        }
        .foregroundStyle(AceDesign.Ink.muted)
        .accessibilityIdentifier("spade.question.pager")
    }

    private var footer: some View {
        HStack(spacing: AceTheme.Spacing.xxs) {
            Button("Answer later") { if let fold { fold() } else { send(["defer": true]) } }
                .buttonStyle(RequestButtonStyle())
                .accessibilityIdentifier("spade.question.later")
            Button("Never mind") { send(["dismiss": true]) }
                .buttonStyle(RequestButtonStyle())
                .accessibilityIdentifier("spade.question.dismiss")
            Spacer(minLength: AceTheme.Spacing.none)
            if loneConfirm {
                Button("No") { answer([.confirm(false)]) }.buttonStyle(RequestButtonStyle())
                    .accessibilityIdentifier("spade.question.no")
                Button("Yes") { answer([.confirm(true)]) }.buttonStyle(RequestButtonStyle(primary: true))
                    .accessibilityIdentifier("spade.question.yes")
            } else if at < count - 1 {
                Button("Next") { page = at + 1; problem = nil }.buttonStyle(RequestButtonStyle(primary: true))
                    .accessibilityIdentifier("spade.question.next")
            } else {
                Button(sending ? "Sending…" : "Send") { answer(drafts) }.buttonStyle(RequestButtonStyle(primary: true))
                    .accessibilityIdentifier("spade.question.send")
            }
        }
        .disabled(sending)
    }

    private func answer(_ these: [SpadeQuestionCard.Draft]) {
        let all = these.count == count ? these : card.questions.map(SpadeQuestionCard.Draft.empty)
        send(["drafts": zip(card.questions, all).map { question, draft in draft.payload(for: question) }])
    }

    /// Out to the bridge, which checks the drafts first: a card that needs more turns to the
    /// question that does, with why under it. The lock is the model's, so a second tap, or the
    /// card drawn again before Spade's update, can't send it twice.
    private func send(_ body: [String: Any]) {
        guard !sending else { return }
        problem = nil
        Task {
            let outcome = await reply(body)
            if outcome.ok { answered += 1; return }
            problem = outcome.problem
            if let named = outcome.at, named >= 0, named < count { page = named }
        }
    }
}
