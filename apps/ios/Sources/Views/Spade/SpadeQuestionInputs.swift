import SwiftUI

/// One question's inputs, by its kind: a field that grows as it is typed into; options to pick,
/// with own words when the question takes them; checks with a count; Yes and No; a number with
/// its unit; a date, and the time when asked.
struct SpadeQuestionInputs: View {
    let question: SpadeQuestionCard.Question
    @Binding var draft: SpadeQuestionCard.Draft
    /// A number's keypad may have no return key: Done above it puts the keyboard away so Send
    /// shows.
    @FocusState private var typingNumber: Bool

    var body: some View {
        switch question.kind {
        case "choice", "choices": picks(many: question.kind == "choices")
        case "confirm": confirm
        case "number": number
        case "date": SpadeDateInput(time: question.time, draft: $draft)
        default:
            field(question.placeholder ?? "Your answer", text: textBinding, lines: 1...6)
                .accessibilityIdentifier("spade.question.text")
        }
    }

    private var textBinding: Binding<String> {
        Binding(get: { if case let .text(text) = draft { text } else { "" } }, set: { draft = .text($0) })
    }

    private var fieldBinding: Binding<String> {
        Binding(get: { if case let .field(text) = draft { text } else { "" } }, set: { draft = .field($0) })
    }

    private func field(_ prompt: String, text: Binding<String>, lines: ClosedRange<Int>) -> some View {
        TextField(prompt, text: text, axis: .vertical)
            .aceFont(AceDesign.TextRole.message)
            .lineLimit(lines)
            .padding(.horizontal, AceDesign.Space.row)
            .padding(.vertical, AceDesign.Space.related)
            .frame(minHeight: AceDesign.Size.tap)
            .background(AceDesign.Surface.fill, in: AceDesign.Shape.field)
    }

    private func picks(many: Bool) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                    let chosen: Bool = if case let .picks(picked, _) = draft { picked.contains(option.label) } else { false }
                    Button { draft = draft.picking(option.label, many: many) } label: {
                        ChoiceRow(chosen: chosen, first: index == 0) {
                            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                                Text(option.label).foregroundStyle(AceTheme.Colours.foreground)
                                if let detail = option.detail {
                                    Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                                }
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(chosen ? .isSelected : [])
                    .accessibilityIdentifier("spade.question.option.\(index)")
                }
                if question.other {
                    let words: String = if case let .picks(_, other) = draft { other } else { "" }
                    ChoiceRow(chosen: !words.isEmpty, first: question.options.isEmpty) {
                        TextField("Something else", text: Binding(get: { words }, set: { draft = draft.writing($0, many: many) }), axis: .vertical)
                            .lineLimit(1...4)
                            .accessibilityIdentifier("spade.question.other")
                    }
                }
            }
            if many, let most = question.most {
                Text("\(draft.pickCount) of \(most) picked")
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .monospacedDigit()
            }
        }
    }

    /// In a card of several, Yes and No are a pick-one pair; a lone one answers from the footer.
    private var confirm: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            ForEach([true, false], id: \.self) { answer in
                let chosen: Bool = if case let .confirm(value) = draft { value == answer } else { false }
                Button { draft = .confirm(answer) } label: {
                    ChoiceRow(chosen: chosen, first: answer) { Text(answer ? "Yes" : "No") }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(chosen ? .isSelected : [])
                .accessibilityIdentifier(answer ? "spade.question.option.yes" : "spade.question.option.no")
            }
        }
    }

    private var number: some View {
        HStack(spacing: AceDesign.Space.related) {
            field("Number", text: fieldBinding, lines: 1...1)
                // The decimal pad has no minus key.
                .keyboardType(question.signed ? .numbersAndPunctuation : .decimalPad)
                .focused($typingNumber)
                .accessibilityIdentifier("spade.question.number")
                .toolbar {
                    if typingNumber {
                        ToolbarItemGroup(placement: .keyboard) {
                            Spacer()
                            Button("Done") { typingNumber = false }
                                .accessibilityIdentifier("spade.question.numberDone")
                        }
                    }
                }
            if let unit = question.unit {
                Text(unit).aceFont(AceDesign.TextRole.message).foregroundStyle(AceDesign.Ink.muted)
            }
        }
    }
}

/// A date (and time) question, shown from the card's draft so paging away and back keeps it.
/// Nothing is picked until the person picks and taps Done, so an untouched card never answers
/// with today, and opening the picker again changes nothing until Done.
private struct SpadeDateInput: View {
    let time: Bool
    @Binding var draft: SpadeQuestionCard.Draft
    /// The date on the open picker; nil while it is closed.
    @State private var choosing: Date?

    private var saved: Date? {
        guard case let .field(text) = draft else { return nil }
        return SpadeQuestionCard.date(from: text, time: time)
    }

    private var label: String {
        guard let saved else { return time ? "Pick a date and time" : "Pick a date" }
        return saved.formatted(date: .abbreviated, time: time ? .shortened : .omitted)
    }

    var body: some View {
        Button(label) { choosing = saved ?? Date() }
            .buttonStyle(RequestButtonStyle())
            .accessibilityIdentifier("spade.question.pickDate")
            .popover(isPresented: Binding(get: { choosing != nil }, set: { if !$0 { choosing = nil } })) {
                picker.presentationCompactAdaptation(.popover)
            }
    }

    private var picker: some View {
        VStack(alignment: .trailing, spacing: AceDesign.Space.related) {
            DatePicker(time ? "Date and time" : "Date", selection: Binding(get: { choosing ?? Date() }, set: { choosing = $0 }),
                       displayedComponents: time ? [.date, .hourAndMinute] : [.date])
                .datePickerStyle(.graphical)
                .labelsHidden()
                .accessibilityIdentifier("spade.question.date")
            Button("Done") { commit() }
                .buttonStyle(RequestButtonStyle(primary: true))
                .accessibilityIdentifier("spade.question.dateDone")
        }
        .padding(AceDesign.Space.margin)
    }

    private func commit() {
        if let choosing { draft = .field(SpadeQuestionCard.dateText(choosing, time: time)) }
        choosing = nil
    }
}
