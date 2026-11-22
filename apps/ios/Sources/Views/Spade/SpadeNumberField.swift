import SwiftUI
import UIKit

/// A number question's field: UIKit's text field, so each edit comes with the exact range it
/// replaced and the keyboard it was typed on, and the draft keeps which keyboard each part of the
/// number came from (`Draft.editingNumber`). A paste over a selection is read as exactly that,
/// never guessed from how the old and new text compare (#2297). Its keypad may have no return
/// key, so Done above it puts the keyboard away and Send shows.
struct SpadeNumberField: UIViewRepresentable {
    @Binding var draft: SpadeQuestionCard.Draft
    /// It may be below zero: the decimal pad has no minus key.
    let signed: Bool

    private var text: String {
        if case let .number(text, _, _) = draft { text } else { "" }
    }

    func makeCoordinator() -> Coordinator { Coordinator(draft: $draft) }

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        field.font = AceDesign.TextRole.message.uiFont(traits: field.traitCollection)
        field.adjustsFontForContentSizeCategory = true
        field.borderStyle = .none
        field.placeholder = "Number"
        field.accessibilityLabel = "Number"
        field.accessibilityIdentifier = "spade.question.number"
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.smartInsertDeleteType = .no
        field.keyboardType = signed ? .numbersAndPunctuation : .decimalPad
        field.inputAccessoryView = Self.doneBar(for: field)
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        field.text = text
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.draft = $draft
        // The draft changed from outside (a card reset): show it, unless words are being composed.
        if field.markedTextRange == nil, field.text != text { field.text = text }
        let keyboard: UIKeyboardType = signed ? .numbersAndPunctuation : .decimalPad
        if field.keyboardType != keyboard {
            field.keyboardType = keyboard
            if field.isFirstResponder { field.reloadInputViews() }
        }
    }

    /// Done above the keypad, which puts the keyboard away.
    private static func doneBar(for field: UITextField) -> UIToolbar {
        let bar = UIToolbar()
        let done = UIBarButtonItem(title: "Done", primaryAction: UIAction { [weak field] _ in field?.resignFirstResponder() })
        done.style = .done
        done.accessibilityIdentifier = "spade.question.numberDone"
        bar.items = [UIBarButtonItem(systemItem: .flexibleSpace), done]
        bar.sizeToFit()
        return bar
    }

    @MainActor final class Coordinator: NSObject, UITextFieldDelegate {
        var draft: Binding<SpadeQuestionCard.Draft>
        /// The edit the field is about to make, as it reported it, until the text changes.
        private var pending: (range: NSRange, string: String, language: String?)?

        init(draft: Binding<SpadeQuestionCard.Draft>) { self.draft = draft }

        func textField(_ field: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
            pending = (range, string, field.textInputMode?.primaryLanguage)
            return true
        }

        @objc func changed(_ field: UITextField) {
            let text = field.text ?? ""
            defer { pending = nil }
            // The reported edit, once it is the one that landed; anything else (Undo, words still
            // being composed) has no known range and is read as such.
            if let pending, field.markedTextRange == nil {
                let edited = draft.wrappedValue.editingNumber(replacing: pending.range, with: pending.string, on: pending.language)
                if case let .number(landed, _, _) = edited, landed == text {
                    draft.wrappedValue = edited
                    return
                }
            }
            draft.wrappedValue = draft.wrappedValue.changingNumber(to: text)
        }
    }
}
