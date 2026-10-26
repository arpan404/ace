import SwiftUI

/// What a composer does with a picked row: edits land in its words with the caret placed after
/// them; builtins go to the screen (`run`); a prompt's form opens; a refusal is said once.
extension ComposerSuggester {
    func choose(_ row: SuggestionRow, text: Binding<String>, place: Binding<CaretPlacement?>, keep: (ComposerPick) -> Void,
                notice: (String) -> Void, run: (String) -> Void) {
        func apply(_ edit: ComposerEdit) {
            // The words change first (moving the picks already made), then the new pick joins them.
            text.wrappedValue = edit.text
            if let pick = edit.pick { keep(pick) }
            place.wrappedValue = CaretPlacement(offset: edit.caret)
        }
        switch pick(row, text: text.wrappedValue, caret: caret) {
        case .edit(let edit): apply(edit)
        case .run(let action, let removed):
            if let removed { apply(removed) }
            if action.hasPrefix("automation.run:") { Task { await runAutomation(action) } } else { run(action) }
        case .arguments: break
        case .notice(let message): notice(message)
        }
    }
}

/// A composer's prompt form: asked from its suggester, answered by the bridge, and the reference
/// with its arguments goes where the `/` word was.
struct ComposerSuggestHost: ViewModifier {
    let suggester: ComposerSuggester?
    @Binding var text: String
    @Binding var place: CaretPlacement?
    let keep: (ComposerPick) -> Void
    func body(content: Content) -> some View {
        if let suggester {
            content
                .sheet(isPresented: Binding(get: { suggester.asking != nil }, set: { if !$0 { suggester.cancelArguments() } })) {
                    if let row = suggester.asking?.row {
                        CommandArgumentsSheet(row: row, answer: suggester.argumentsAnswer,
                                              submit: { suggester.submitArguments($0) }, cancel: { suggester.cancelArguments() })
                    }
                }
                .onChange(of: suggester.argumentsAnswer) { _, answer in
                    guard let reference = answer?.reference else { return }
                    let edit = suggester.answered(reference, text: text, caret: suggester.caret)
                    text = edit.text
                    if let pick = edit.pick { keep(pick) }
                    place = CaretPlacement(offset: edit.caret)
                }
        } else {
            content
        }
    }
}

/// The + list's builtins as menu rows, after the phone's own Photo Library, Take Photo and Choose
/// File (its "Attach files").
struct ComposerAddRows: View {
    let rows: [SuggestionRow]
    let pick: (SuggestionRow) -> Void
    var body: some View {
        let more = rows.filter { $0.action != "attach" }
        if !more.isEmpty {
            Divider()
            ForEach(more) { row in
                Button(row.label, ace: SuggestionSymbol.icon(row)) { pick(row) }
                    .accessibilityIdentifier("composer.add.\(row.action ?? row.id)")
            }
        }
    }
}
