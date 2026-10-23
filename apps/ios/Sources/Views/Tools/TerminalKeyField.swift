import SwiftUI
import UIKit

/// The terminal's keyboard focus. It holds no text: every keystroke goes straight to the
/// terminal, as in a desktop terminal, and hardware keys (Ctrl, Option, Esc, arrows) are read
/// before the text system turns them into editing commands.
final class TerminalKeyTextField: UITextField, UITextFieldDelegate {
    var onText: (String) -> Void = { _ in }
    var onDelete: () -> Void = {}
    var onReturn: () -> Void = {}
    var onKey: (TerminalInput) -> Void = { _ in }

    override init(frame: CGRect) {
        super.init(frame: frame)
        autocorrectionType = .no
        autocapitalizationType = .none
        spellCheckingType = .no
        smartQuotesType = .no
        smartDashesType = .no
        smartInsertDeleteType = .no
        inlinePredictionType = .no
        keyboardType = .asciiCapable
        returnKeyType = .default
        textContentType = .none
        delegate = self
    }
    required init?(coder: NSCoder) { nil }

    /// Every edit (keyboard, hardware typing, paste, dictation) is sent and never kept.
    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        if string.isEmpty { onDelete() } else { onText(string) }
        return false
    }
    func textFieldShouldReturn(_ textField: UITextField) -> Bool { onReturn(); return false }
    /// The field is always empty, so a delete arrives here rather than as an edit.
    override func deleteBackward() { onDelete() }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var rest = Set<UIPress>()
        for press in presses {
            if let key = press.key, let input = Self.hardware(key).input { onKey(input) } else { rest.insert(press) }
        }
        if !rest.isEmpty { super.pressesBegan(rest, with: event) }
    }
    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        let rest = presses.filter { press in press.key.map { Self.hardware($0).input == nil } ?? true }
        if !rest.isEmpty { super.pressesEnded(rest, with: event) }
    }

    private static func hardware(_ key: UIKey) -> HardwareKey {
        let flags = key.modifierFlags
        return HardwareKey(
            named: named(key.keyCode),
            character: key.charactersIgnoringModifiers,
            ctrl: flags.contains(.control),
            alt: flags.contains(.alternate),
            shift: flags.contains(.shift),
            command: flags.contains(.command)
        )
    }
    private static func named(_ code: UIKeyboardHIDUsage) -> HardwareKey.Named? {
        switch code {
        case .keyboardEscape: .escape
        case .keyboardTab: .tab
        case .keyboardReturnOrEnter, .keypadEnter: .enter
        case .keyboardDeleteOrBackspace: .backspace
        case .keyboardDeleteForward: .delete
        case .keyboardUpArrow: .up
        case .keyboardDownArrow: .down
        case .keyboardLeftArrow: .left
        case .keyboardRightArrow: .right
        case .keyboardHome: .home
        case .keyboardEnd: .end
        case .keyboardPageUp: .pageUp
        case .keyboardPageDown: .pageDown
        default:
            if code.rawValue >= UIKeyboardHIDUsage.keyboardF1.rawValue, code.rawValue <= UIKeyboardHIDUsage.keyboardF12.rawValue {
                .function(code.rawValue - UIKeyboardHIDUsage.keyboardF1.rawValue + 1)
            } else { nil }
        }
    }
}

struct TerminalKeyField: UIViewRepresentable {
    let enabled: Bool
    @Binding var focused: Bool
    let onText: (String) -> Void
    let onDelete: () -> Void
    let onReturn: () -> Void
    let onKey: (TerminalInput) -> Void

    func makeUIView(context: Context) -> TerminalKeyTextField {
        let field = TerminalKeyTextField()
        field.placeholder = "Type here"
        field.font = UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .regular)
        field.adjustsFontForContentSizeCategory = true
        field.accessibilityIdentifier = "terminal.input"
        field.accessibilityLabel = "Terminal input"
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.addAction(UIAction { _ in context.coordinator.focus(true) }, for: .editingDidBegin)
        field.addAction(UIAction { _ in context.coordinator.focus(false) }, for: .editingDidEnd)
        return field
    }
    func updateUIView(_ field: TerminalKeyTextField, context: Context) {
        context.coordinator.parent = self
        field.onText = { onText($0) }
        field.onDelete = { onDelete() }
        field.onReturn = { onReturn() }
        field.onKey = { onKey($0) }
        field.isEnabled = enabled
        if focused, enabled, !field.isFirstResponder { DispatchQueue.main.async { field.becomeFirstResponder() } }
        if !focused, field.isFirstResponder { DispatchQueue.main.async { field.resignFirstResponder() } }
    }
    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor final class Coordinator {
        var parent: TerminalKeyField
        init(parent: TerminalKeyField) { self.parent = parent }
        func focus(_ value: Bool) { if parent.focused != value { parent.focused = value } }
    }
}
