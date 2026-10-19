import UIKit

/// The phone's keyboard for the page's focused field, matched to it: the page's own `inputmode`
/// and `enterkeyhint` win, otherwise the input's type decides. Passwords, addresses and URLs get
/// no autocorrect or capitals.
struct KeyboardStyle: Equatable {
    var keyboard: UIKeyboardType = .default
    var returnKey: UIReturnKeyType = .default
    var assisted = true
    var secure = false

    init(_ focus: BrowserPageInfo.Focus) {
        let type = focus.type.lowercased()
        switch focus.inputMode?.lowercased() {
        case "numeric": keyboard = .numberPad
        case "decimal": keyboard = .decimalPad
        case "tel": keyboard = .phonePad
        case "email": keyboard = .emailAddress
        case "url": keyboard = .URL
        case "search": keyboard = .webSearch
        case "text": keyboard = .default
        default:
            keyboard = switch type {
            case "email": .emailAddress
            case "url": .URL
            case "tel": .phonePad
            case "number": .decimalPad
            case "search": .webSearch
            default: .default
            }
        }
        switch focus.enterKeyHint?.lowercased() {
        case "done": returnKey = .done
        case "go": returnKey = .go
        case "next": returnKey = .next
        case "search": returnKey = .search
        case "send": returnKey = .send
        case "enter", "previous": returnKey = .default
        default: returnKey = type == "search" ? .search : .default
        }
        assisted = !["password", "email", "url"].contains(type)
        secure = type == "password"
    }
}

/// A hidden text field (UIKit's `UITextInput`) standing in for the page's focused field, so the
/// system keyboard, autocorrect, dictation and IMEs work as in any app. What it holds is replayed
/// in the page by `RemoteTyping`.
final class RemoteTextField: UITextField, UITextFieldDelegate {
    var onInput: ([RemoteInput]) -> Void = { _ in }
    private var typing = RemoteTyping()

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        alpha = 0.02
        textColor = .clear
        tintColor = .clear
        borderStyle = .none
        smartInsertDeleteType = .no
        accessibilityElementsHidden = true
        addTarget(self, action: #selector(changed), for: .editingChanged)
    }
    @available(*, unavailable) required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func configure(_ style: KeyboardStyle) {
        keyboardType = style.keyboard
        returnKeyType = style.returnKey
        autocorrectionType = style.assisted ? .default : .no
        autocapitalizationType = style.assisted ? .sentences : .none
        spellCheckingType = style.assisted ? .default : .no
        isSecureTextEntry = style.secure
        if isFirstResponder { reloadInputViews() }
    }
    /// Another field took focus in the page: type from an empty field.
    func restart() {
        text = ""
        typing.reset()
    }

    @objc private func changed() { refresh() }
    override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        super.setMarkedText(markedText, selectedRange: selectedRange)
        refresh()
    }
    override func unmarkText() {
        super.unmarkText()
        refresh()
    }
    override func deleteBackward() {
        // Nothing left here, but the page's field may still have text before its caret.
        if (text ?? "").isEmpty { onInput(RemoteTyping.backspace) }
        super.deleteBackward()
    }
    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        onInput(RemoteTyping.enter)
        return false
    }

    /// The field's text without its marked (composing) text, the caret, and the marked text.
    private func refresh() {
        let full = text ?? ""
        let units = Array(full.utf16)
        let offset = { (position: UITextPosition) in min(max(self.offset(from: self.beginningOfDocument, to: position), 0), units.count) }
        if let marked = markedTextRange {
            let start = offset(marked.start), end = max(offset(marked.end), start)
            let plain = String(decoding: units[..<start] + units[end...], as: UTF16.self)
            let composing = String(decoding: units[start..<end], as: UTF16.self)
            onInput(typing.update(plain: plain, caret: start, marked: composing))
        } else {
            let caret = selectedTextRange.map { offset($0.start) } ?? units.count
            onInput(typing.update(plain: full, caret: caret, marked: nil))
        }
    }
}
