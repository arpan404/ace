import SwiftUI

/// What the person has picked or typed for each question. Pure.
struct QuestionAnswers: Equatable {
    var picked: [String: [String]] = [:]
    var written: [String: String] = [:]

    mutating func pick(_ choice: String, in question: ApprovalRow.Question) {
        var current = picked[question.id] ?? []
        if question.multiSelect {
            if let index = current.firstIndex(of: choice) { current.remove(at: index) } else { current.append(choice) }
        } else {
            current = [choice]
            written[question.id] = nil
        }
        picked[question.id] = current
    }
    /// Own words replace a single choice; they join a multiple one.
    mutating func write(_ text: String, in question: ApprovalRow.Question) {
        written[question.id] = text
        if !question.multiSelect, !text.isEmpty { picked[question.id] = [] }
    }
    /// The answer for each question, or nil while any question is unanswered.
    func resolution(for questions: [ApprovalRow.Question]) -> [String: [String]]? {
        var answers: [String: [String]] = [:]
        for question in questions {
            var values = picked[question.id] ?? []
            let own = (written[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if question.allowOther, !own.isEmpty { values.append(own) }
            guard !values.isEmpty else { return nil }
            answers[question.id] = values
        }
        return answers
    }
}

/// A question card's state while it is above the composer.
struct QuestionDraftState: Equatable {
    var answers = QuestionAnswers()
    var page = 0
}

/// The card as the person left it, sent with words typed in the composer: the bridge decides
/// whether they answer it.
struct QuestionReply {
    let interactionId: String
    let draft: QuestionDraftState
    var payload: [String: Any] {
        ["interactionId": interactionId, "picked": draft.answers.picked, "written": draft.answers.written, "at": draft.page]
    }
}

/// The agent's question above the composer, one question at a time, as a grouped list: its
/// choices as rows with a checkmark on the chosen, the person's own words where allowed, then Skip
/// and Continue as plain words. Controls stay locked while the
/// answer saves and until the daemon closes the card. Long choices scroll inside the card, which
/// never takes more than about half the screen.
struct QuestionCard: View {
    let interaction: ApprovalRow
    let submission: ApprovalSubmission?
    /// A view-only machine shows the question but can't answer it.
    var canAct = true
    /// The tallest the card may grow.
    var maxHeight: CGFloat = .infinity
    /// The picks, words and question on screen, kept by the thread so words typed in the
    /// composer can answer it with them.
    @Binding var draft: QuestionDraftState
    let answer: ([String: [String]], Bool) -> Void
    private var answers: QuestionAnswers { get { draft.answers } nonmutating set { draft.answers = newValue } }
    private var page: Int { get { draft.page } nonmutating set { draft.page = newValue } }
    /// The choices' own height; past the cap they scroll inside the card.
    @State private var choicesHeight: CGFloat = 0
    var body: some View {
        let questions = interaction.questions ?? []
        let index = min(page, max(questions.count - 1, 0))
        let question = questions.indices.contains(index) ? questions[index] : nil
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            if let question {
                RequestHeader(title: question.text, detail: [question.header, questions.count > 1 ? "\(index + 1) of \(questions.count)" : ""].filter { !$0.isEmpty }.joined(separator: " · "))
                ScrollView {
                    choices(question).onGeometryChange(for: CGFloat.self) { $0.size.height } action: { choicesHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: min(choicesHeight, max(AceTheme.Dimensions.touchTarget * 2, maxHeight - AceTheme.Dimensions.touchTarget * 4.5)))
                .id(question.id)
            }
            if interaction.unanswerable == true {
                Text("This question has more choices than fit here. Answer it on your machine.").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            RequestActions {
                Button(questions.count > 1 ? "Skip these questions" : "Skip this question") { answer([:], true) }
                    .buttonStyle(RequestButtonStyle())
                    .accessibilityIdentifier("question.skip")
                if interaction.unanswerable != true {
                    let last = index >= questions.count - 1
                    Button("Continue") {
                        if !last { page = index + 1 }
                        else if let resolution = answers.resolution(for: questions) { answer(resolution, false) }
                    }
                    .buttonStyle(RequestButtonStyle(primary: true))
                    .disabled(question.map { answers.resolution(for: [$0]) == nil } ?? true)
                    .accessibilityIdentifier(last ? "question.answer" : "question.next")
                }
            }.disabled(submission != nil || !canAct)
            RequestFooter(submission: submission, canAct: canAct)
        }
        .modifier(RequestCardFrame(submission: submission))
    }
    private func choices(_ question: ApprovalRow.Question) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            ForEach(Array(question.options.enumerated()), id: \.element.id) { index, choice in
                let chosen = answers.picked[question.id]?.contains(choice.id) == true
                Button { answers.pick(choice.id, in: question) } label: {
                    ChoiceRow(chosen: chosen, first: index == 0) {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                            HStack(spacing: AceTheme.Spacing.xs) {
                                Text(choice.label).foregroundStyle(AceTheme.Colours.foreground)
                                if choice.recommended { Text("Recommended").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
                            }
                            if !choice.detail.isEmpty { Text(choice.detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(!canAct)
                .accessibilityAddTraits(chosen ? .isSelected : [])
                .accessibilityIdentifier("question.\(question.id).\(choice.id)")
            }
            if question.allowOther {
                let words = answers.written[question.id] ?? ""
                ChoiceRow(chosen: !words.isEmpty, first: question.options.isEmpty) {
                    TextField("Something else…", text: Binding(get: { words }, set: { answers.write($0, in: question) }), axis: .vertical)
                        .lineLimit(1...4)
                        .accessibilityIdentifier("question.\(question.id).other")
                }
                .disabled(!canAct)
            }
        }
    }
}

/// One choice as a grouped row: its words on the left, a checkmark on the right when chosen.
private struct ChoiceRow<Content: View>: View {
    let chosen: Bool
    let first: Bool
    @ViewBuilder var content: () -> Content
    var body: some View {
        GroupedRow(first: first) {
            HStack(alignment: .center, spacing: AceTheme.Spacing.md) {
                content()
                Spacer(minLength: AceTheme.Spacing.none)
                Image(systemName: "checkmark").font(.body.weight(.semibold))
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .opacity(chosen ? 1 : 0)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
        }
    }
}
