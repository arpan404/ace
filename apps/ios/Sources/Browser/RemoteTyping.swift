import Foundation

/// Typing into the page's focused field through a hidden local text field, so the phone's own
/// keyboard, autocorrect, swipe typing, dictation and IMEs all work. The local field holds what
/// was typed since the page's field took focus; each change to it is replayed at the page's caret
/// as Backspace and Delete presses and inserted text, and text an IME is composing is shown marked
/// in the page. Pure: the view feeds it the field's text, caret and marked text.
struct RemoteTyping {
    /// Backspaces and Deletes at the caret (in characters), then text inserted there.
    struct Edit: Equatable {
        var backspaces = 0
        var deletes = 0
        var text = ""
        var isEmpty: Bool { backspaces == 0 && deletes == 0 && text.isEmpty }
    }
    /// The field's committed text (without marked text) and caret, in UTF-16 units.
    private(set) var text = ""
    private(set) var caret = 0
    /// The IME composition the page shows marked, if any.
    private(set) var composing: String?

    /// Another field took focus: start from an empty local field.
    mutating func reset() { text = ""; caret = 0; composing = nil }

    /// The local field changed. `plain` is its text without any marked text, `caret` where the
    /// marked text (else the caret) is, and `marked` the text an IME is composing there.
    mutating func update(plain: String, caret newCaret: Int, marked: String?) -> [RemoteInput] {
        let caretAfter = min(max(newCaret, 0), plain.utf16.count)
        let edit = Self.edit(before: text, caretBefore: caret, after: plain, caretAfter: caretAfter)
        var inputs = Self.inputs(for: edit)
        let marked = marked?.isEmpty == true ? nil : marked
        if let marked, marked != composing {
            // `ime` bounds its text and selection at 4,096 units; a longer composition is cut.
            let shown = Self.prefix(marked, units: 4096)
            let end = shown.utf16.count
            inputs.append(.ime(text: shown, selectionStart: end, selectionEnd: end))
        } else if marked == nil, composing != nil, edit.text.isEmpty {
            // The composition was abandoned: nothing commits it, so the page drops it.
            inputs.append(.ime(text: "", selectionStart: 0, selectionEnd: 0))
        }
        text = plain
        caret = caretAfter
        composing = marked
        return inputs
    }

    /// Return on the keyboard: Enter in the page (a form submits as it would on a keyboard).
    static var enter: [RemoteInput] { press("Enter", text: "\r") }
    /// Backspace on an empty local field still deletes in the page.
    static var backspace: [RemoteInput] { press("Backspace") }

    /// The edit that turns `before` (caret at `caretBefore`) into `after` (caret at `caretAfter`):
    /// everything between the first difference and the old caret is deleted, then the new text up
    /// to the new caret typed. Autocorrect replacing the word behind the caret, a swipe-typed word
    /// and a plain keystroke all come out as one edit at the caret.
    static func edit(before: String, caretBefore: Int, after: String, caretAfter: Int) -> Edit {
        let old = Array(before.utf16), new = Array(after.utf16)
        let caretBefore = min(max(caretBefore, 0), old.count), caretAfter = min(max(caretAfter, 0), new.count)
        let limit = min(caretBefore, caretAfter)
        var same = 0
        while same < limit, old[same] == new[same] { same += 1 }
        // Never split a character made of two UTF-16 units.
        if same > 0, UTF16.isLeadSurrogate(old[same - 1]) { same -= 1 }
        let tailBefore = Array(old[caretBefore...]), tailAfter = Array(new[caretAfter...])
        let deletes = tailBefore.count >= tailAfter.count && Array(tailBefore.suffix(tailAfter.count)) == tailAfter
            ? characters(Array(tailBefore.prefix(tailBefore.count - tailAfter.count))) : 0
        return Edit(backspaces: characters(Array(old[same..<caretBefore])), deletes: deletes,
                    text: String(decoding: new[same..<caretAfter], as: UTF16.self))
    }

    /// The input that replays an edit: key presses for deletions, inserted text in pieces the wire
    /// takes (256 UTF-16 units, whole characters), and line breaks as Enter.
    static func inputs(for edit: Edit) -> [RemoteInput] {
        var inputs: [RemoteInput] = []
        for _ in 0..<edit.backspaces { inputs += press("Backspace") }
        for _ in 0..<edit.deletes { inputs += press("Delete") }
        let lines = edit.text.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false)
        for (index, line) in lines.enumerated() {
            if index > 0 { inputs += enter }
            var piece = ""
            for character in line {
                if piece.utf16.count + character.utf16.count > 256 {
                    inputs.append(.key(event: "char", key: "Unidentified", text: piece))
                    piece = ""
                }
                piece.append(character)
            }
            if !piece.isEmpty { inputs.append(.key(event: "char", key: "Unidentified", text: piece)) }
        }
        return inputs
    }

    private static func press(_ key: String, text: String? = nil) -> [RemoteInput] {
        [.key(event: "keyDown", key: key, code: key, text: text), .key(event: "keyUp", key: key, code: key)]
    }
    /// How many characters (what a Backspace removes) these UTF-16 units hold.
    private static func characters(_ units: [UInt16]) -> Int { String(decoding: units, as: UTF16.self).count }
    private static func prefix(_ text: String, units: Int) -> String {
        var result = ""
        for character in text {
            if result.utf16.count + character.utf16.count > units { break }
            result.append(character)
        }
        return result
    }
}
