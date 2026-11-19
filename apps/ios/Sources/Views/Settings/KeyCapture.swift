import SwiftUI
import UIKit

/// Records a shortcut pressed on a hardware keyboard while the editor shows: a ⌘ or ⌃ chord is
/// reported in the keymap's notation; other presses pass on (typing, Esc to close).
struct KeyCapture: UIViewRepresentable {
    let pressed: (Set<String>, String) -> Void
    func makeUIView(context: Context) -> CaptureView { CaptureView() }
    func updateUIView(_ view: CaptureView, context: Context) { view.pressed = pressed }

    final class CaptureView: UIView {
        var pressed: ((Set<String>, String) -> Void)?
        override var canBecomeFirstResponder: Bool { true }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil { DispatchQueue.main.async { [weak self] in self?.becomeFirstResponder() } }
        }
        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            guard let key = presses.compactMap(\.key).first, let chord = Self.chord(key) else {
                super.pressesBegan(presses, with: event)
                return
            }
            pressed?(chord.modifiers, chord.key)
        }
        static func chord(_ key: UIKey) -> (modifiers: Set<String>, key: String)? {
            var modifiers: Set<String> = []
            if key.modifierFlags.contains(.control) { modifiers.insert("ctrl") }
            if key.modifierFlags.contains(.alternate) { modifiers.insert("alt") }
            if key.modifierFlags.contains(.shift) { modifiers.insert("shift") }
            if key.modifierFlags.contains(.command) { modifiers.insert("mod") }
            guard modifiers.contains("mod") || modifiers.contains("ctrl") else { return nil }
            let named: [UIKeyboardHIDUsage: String] = [
                .keyboardReturnOrEnter: "enter", .keyboardEscape: "escape", .keyboardTab: "tab",
                .keyboardSpacebar: "space", .keyboardDeleteOrBackspace: "backspace",
                .keyboardUpArrow: "arrowup", .keyboardDownArrow: "arrowdown",
                .keyboardLeftArrow: "arrowleft", .keyboardRightArrow: "arrowright",
            ]
            let name = named[key.keyCode] ?? key.charactersIgnoringModifiers.lowercased()
            guard PhoneKeymapTable.keyNames[name] != nil else { return nil }
            return (modifiers, name)
        }
    }
}
