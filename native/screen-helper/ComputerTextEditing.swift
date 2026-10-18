import AppKit
import ApplicationServices

/// Text editing through accessibility. Background apps ignore ⌘A/⌘C/⌘X/⌘V (they route those
/// through the active app's first responder), but a text element's selection and selected
/// text can be read and replaced directly, exactly and without the clipboard.
struct CUTextTarget {
    let element: AXUIElement

    /// The focused element when it is editable text.
    static func focused(in application: AXUIElement) -> CUTextTarget? {
        guard let focused = cuAttribute(application, "AXFocusedUIElement") else { return nil }
        let element = focused as! AXUIElement
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, "AXSelectedTextRange" as CFString, &settable) == .success, settable.boolValue else { return nil }
        return CUTextTarget(element: element)
    }

    var length: Int { (cuAttribute(element, "AXNumberOfCharacters") as? NSNumber)?.intValue ?? (cuAttribute(element, "AXValue") as? String)?.utf16.count ?? 0 }
    var selected: String { cuAttribute(element, "AXSelectedText") as? String ?? "" }

    func selectAll() -> Bool {
        var range = CFRange(location: 0, length: length)
        guard let value = AXValueCreate(.cfRange, &range) else { return false }
        return AXUIElementSetAttributeValue(element, "AXSelectedTextRange" as CFString, value) == .success
    }

    /// Replaces the selection (or inserts at the caret). True when the text actually changed.
    func replaceSelection(_ text: String) -> Bool {
        let before = cuAttribute(element, "AXValue") as? String
        guard AXUIElementSetAttributeValue(element, "AXSelectedText" as CFString, text as CFString) == .success else { return false }
        return text.isEmpty || before != cuAttribute(element, "AXValue") as? String
    }
}

/// The editing commands emulated for background text, by chord.
enum CUTextCommand { case selectAll, copy, cut, paste }
func cuTextCommand(_ chord: CUChord) -> CUTextCommand? {
    guard chord.flags.intersection([.maskCommand, .maskShift, .maskAlternate, .maskControl]) == .maskCommand else { return nil }
    switch chord.text {
    case "a": return .selectAll
    case "c": return .copy
    case "x": return .cut
    case "v": return .paste
    default: return nil
    }
}

@MainActor func cuRunTextCommand(_ command: CUTextCommand, on target: CUTextTarget) -> String? {
    let board = NSPasteboard.general
    switch command {
    case .selectAll: return target.selectAll() ? "selected all text" : nil
    case .copy:
        let text = target.selected
        guard !text.isEmpty else { return "copied nothing (no text selected)" }
        board.clearContents(); board.setString(text, forType: .string)
        return "copied \(text.count) characters"
    case .cut:
        let text = target.selected
        guard !text.isEmpty else { return "cut nothing (no text selected)" }
        board.clearContents(); board.setString(text, forType: .string)
        return target.replaceSelection("") ? "cut \(text.count) characters" : nil
    case .paste:
        guard let text = board.string(forType: .string) else { return "pasted nothing (the clipboard has no text)" }
        return target.replaceSelection(text) ? "pasted \(text.count) characters" : nil
    }
}
