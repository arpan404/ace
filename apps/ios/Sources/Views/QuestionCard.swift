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

/// The agent's question, answered in place: its choices, the person's own words where allowed,
/// or Skip. Controls stay locked while the answer saves and until the daemon closes the card.
struct QuestionCard: View {
    @Environment(\.colorScheme) private var colourScheme
    let interaction: ApprovalRow
    let submission: ApprovalSubmission?
    let answer: ([String: [String]], Bool) -> Void
    @State private var answers = QuestionAnswers()
    var body: some View {
        let questions = interaction.questions ?? []
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            ForEach(questions) { question in
                VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                    if !question.header.isEmpty {
                        Text(question.header).aceFont(AceTheme.Typography.label, relativeTo: .caption).foregroundStyle(AceTheme.StatusText.needsYou)
                    }
                    Text(question.text).aceFont(AceTheme.Typography.title, relativeTo: .headline).fixedSize(horizontal: false, vertical: true)
                    ForEach(question.options) { choice in
                        let chosen = answers.picked[question.id]?.contains(choice.id) == true
                        Button { answers.pick(choice.id, in: question) } label: {
                            HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                                Image(systemName: chosen ? (question.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle") : (question.multiSelect ? "square" : "circle"))
                                    .foregroundStyle(chosen ? AceTheme.Colours.foreground : AceTheme.Colours.decoration)
                                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                                    HStack(spacing: AceTheme.Spacing.xs) {
                                        Text(choice.label).foregroundStyle(AceTheme.Colours.foreground)
                                        if choice.recommended { Text("Recommended").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
                                    }
                                    if !choice.detail.isEmpty { Text(choice.detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
                                }
                                Spacer(minLength: AceTheme.Spacing.none)
                            }
                            .aceFont(AceTheme.Typography.body, relativeTo: .body)
                            .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(chosen ? .isSelected : [])
                        .accessibilityIdentifier("question.\(question.id).\(choice.id)")
                    }
                    if question.allowOther {
                        TextField("Something else…", text: Binding(get: { answers.written[question.id] ?? "" }, set: { answers.write($0, in: question) }), axis: .vertical)
                            .aceFont(AceTheme.Typography.body, relativeTo: .body).lineLimit(1...4)
                            .padding(AceTheme.Spacing.md).frame(minHeight: AceTheme.Dimensions.touchTarget)
                            .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.button))
                            .accessibilityIdentifier("question.\(question.id).other")
                    }
                }
            }
            if interaction.unanswerable == true {
                Text("This question has more choices than fit here. Answer it on your machine.").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            HStack(spacing: AceTheme.Spacing.sm) {
                Button { answer([:], true) } label: {
                    Text("Skip").aceFont(AceTheme.Typography.label, relativeTo: .subheadline).frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget)
                        .foregroundStyle(AceTheme.Colours.foreground).background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.button))
                }.buttonStyle(.plain).accessibilityIdentifier("question.skip")
                if interaction.unanswerable != true {
                    let resolution = answers.resolution(for: questions)
                    Button { if let resolution { answer(resolution, false) } } label: {
                        Text("Answer").aceFont(AceTheme.Typography.label, relativeTo: .subheadline).frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget)
                            .foregroundStyle(AceTheme.Colours.background).background(AceTheme.Colours.foreground, in: RoundedRectangle(cornerRadius: AceTheme.Radii.button))
                    }.buttonStyle(.plain).disabled(resolution == nil).opacity(resolution == nil ? AceTheme.Opacity.disabled(colourScheme) : 1)
                    .accessibilityIdentifier("question.answer")
                }
            }.disabled(submission != nil)
            if let submission { Label(submission.phase == .saving ? "Saving your answer…" : "Waiting for the daemon", systemImage: "clock").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
        }
        .padding(AceTheme.Spacing.lg).background(AceTheme.Colours.card, in: RoundedRectangle(cornerRadius: AceTheme.Radii.approval))
        .overlay(RoundedRectangle(cornerRadius: AceTheme.Radii.approval).stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
        .shadow(color: AceTheme.Colours.shadow.opacity(AceTheme.Opacity.shadow(colourScheme)), radius: AceTheme.Elevation.floating, y: AceTheme.Elevation.card)
        .padding(.horizontal, AceTheme.Dimensions.composerInset).padding(.bottom, AceTheme.Spacing.sm)
        .sensoryFeedback(.selection, trigger: submission?.requestId)
    }
}
