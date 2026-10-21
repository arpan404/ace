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

/// The agent's question in the composer's place, one question at a time: its choices as rows,
/// the person's own words where allowed, Continue, and Skip. Controls stay locked while the
/// answer saves and until the daemon closes the card. Long choices scroll inside the card, which
/// never takes more than about half the screen.
struct QuestionCard: View {
    let interaction: ApprovalRow
    let submission: ApprovalSubmission?
    /// A view-only machine shows the question but can't answer it.
    var canAct = true
    /// The tallest the card may grow.
    var maxHeight: CGFloat = .infinity
    let answer: ([String: [String]], Bool) -> Void
    @State private var answers = QuestionAnswers()
    @State private var page = 0
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
            VStack(spacing: AceTheme.Spacing.xs) {
                if interaction.unanswerable != true {
                    let last = index >= questions.count - 1
                    Button("Continue") {
                        if !last { page = index + 1 }
                        else if let resolution = answers.resolution(for: questions) { answer(resolution, false) }
                    }
                    .buttonStyle(.pillPrimary)
                    .disabled(question.map { answers.resolution(for: [$0]) == nil } ?? true)
                    .accessibilityIdentifier(last ? "question.answer" : "question.next")
                }
                Button(questions.count > 1 ? "Skip these questions" : "Skip this question") { answer([:], true) }
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
                    .accessibilityIdentifier("question.skip")
            }.disabled(submission != nil || !canAct)
            RequestFooter(submission: submission, canAct: canAct)
        }
        .modifier(RequestCardFrame(submission: submission))
    }
    private func choices(_ question: ApprovalRow.Question) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            ForEach(question.options) { choice in
                let chosen = answers.picked[question.id]?.contains(choice.id) == true
                Button { answers.pick(choice.id, in: question) } label: {
                    ChoiceRow(chosen: chosen, multiple: question.multiSelect) {
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
                ChoiceRow(chosen: !words.isEmpty, multiple: question.multiSelect) {
                    TextField("Something else…", text: Binding(get: { words }, set: { answers.write($0, in: question) }), axis: .vertical)
                        .lineLimit(1...4)
                        .accessibilityIdentifier("question.\(question.id).other")
                }
                .disabled(!canAct)
            }
        }
    }
}

/// One choice: a radio (or check box) and its words on the page colour; the chosen one takes an
/// ink ring.
private struct ChoiceRow<Content: View>: View {
    let chosen: Bool
    let multiple: Bool
    @ViewBuilder var content: () -> Content
    var body: some View {
        HStack(alignment: .center, spacing: AceTheme.Spacing.md) {
            Group {
                if multiple {
                    Image(systemName: chosen ? "checkmark.square.fill" : "square")
                } else {
                    Circle()
                        .strokeBorder(chosen ? AceTheme.Colours.foreground : AceTheme.Colours.decoration,
                                      lineWidth: chosen ? AceTheme.Spacing.xs + AceTheme.Spacing.xxs : AceTheme.Dimensions.border * 1.5)
                        .frame(width: AceTheme.Spacing.xl, height: AceTheme.Spacing.xl)
                }
            }
            .foregroundStyle(chosen ? AceTheme.Colours.foreground : AceTheme.Colours.decoration)
            content()
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .aceFont(AceTheme.Typography.body, relativeTo: .body)
        .padding(.horizontal, AceTheme.Spacing.md + AceTheme.Spacing.xxs).padding(.vertical, AceTheme.Spacing.md)
        .frame(minHeight: AceTheme.Dimensions.touchTarget)
        .background(AceTheme.Colours.background, in: RoundedRectangle(cornerRadius: AceTheme.Radii.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AceTheme.Radii.card, style: .continuous)
            .strokeBorder(chosen ? AceTheme.Colours.foreground : .clear, lineWidth: AceTheme.Dimensions.border * 1.5))
        .contentShape(Rectangle())
    }
}
