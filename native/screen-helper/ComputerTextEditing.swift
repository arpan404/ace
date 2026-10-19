import AppKit
import ApplicationServices

/// What can be observed of a text element's content: its length, selection and (when neither
/// is reported) its value. Two states differ when the text or the caret moved.
struct CUTextState: Equatable {
    var count: Int?
    var selection: NSRange?
    var value: String?
    var observable: Bool { count != nil || selection != nil || value != nil }
}

/// The result of inserting text through accessibility.
enum CUInsertOutcome: Equatable {
    /// The text or caret visibly changed.
    case changed
    /// The app accepted the call but reports nothing to check; the text may well be there.
    case unverified
    /// The app accepted the call and nothing changed: it ignored it, so another path is safe.
    case ignored
    /// The app refused the call.
    case refused
}

/// Decides an insertion's outcome from what the app reported. Pure.
func cuInsertOutcome(accepted: Bool, before: CUTextState, after: CUTextState) -> CUInsertOutcome {
    guard accepted else { return .refused }
    if before != after { return .changed }
    return before.observable ? .ignored : .unverified
}

/// How many UTF-16 units landed between two states: the caret's advance when the selection is
/// reported (typing replaces a selection, so length alone misleads), else the growth in length.
func cuLandedUnits(before: CUTextState, after: CUTextState) -> Int? {
    if let start = before.selection, let end = after.selection { return end.location - start.location }
    if let start = before.count, let end = after.count { return end - start }
    if let start = before.value, let end = after.value { return end.utf16.count - start.utf16.count }
    return nil
}

private let cuTextStateAttributes = ["AXNumberOfCharacters", "AXSelectedTextRange"]

/// Text editing through accessibility. Background apps ignore ⌘A/⌘C/⌘X/⌘V (they route those
/// through the active app's first responder), but a text element's selection and selected
/// text can be read and replaced directly, exactly and without the clipboard.
@MainActor struct CUTextTarget {
    let element: AXUIElement

    /// An element whose selection can be set, i.e. editable text.
    init?(_ element: AXUIElement) {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, "AXSelectedTextRange" as CFString, &settable) == .success, settable.boolValue else { return nil }
        self.element = element
    }

    static func focused(in application: AXUIElement) -> CUTextTarget? {
        cuAttribute(application, "AXFocusedUIElement").flatMap { CUTextTarget($0 as! AXUIElement) }
    }

    /// One round trip for length and selection; the value only when neither exists.
    var state: CUTextState {
        var state = CUTextState()
        var values: CFArray?
        if AXUIElementCopyMultipleAttributeValues(element, cuTextStateAttributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
           let array = values as? [AnyObject], array.count == 2 {
            state.count = (array[0] as? NSNumber)?.intValue
            if CFGetTypeID(array[1]) == AXValueGetTypeID() {
                var range = CFRange()
                if AXValueGetValue(array[1] as! AXValue, .cfRange, &range) { state.selection = NSRange(location: range.location, length: range.length) }
            }
        }
        if state.count == nil, state.selection == nil { state.value = cuAttribute(element, "AXValue") as? String }
        return state
    }

    var length: Int { state.count ?? (cuAttribute(element, "AXValue") as? String)?.utf16.count ?? 0 }
    var selected: String { cuAttribute(element, "AXSelectedText") as? String ?? "" }

    /// Waits up to `withinMs` (in 25 ms steps) for the state to move away from `before`.
    /// Chromium and Electron apply edits asynchronously, so "unchanged right now" means little.
    func changed(since before: CUTextState, withinMs: Int) async -> Bool {
        var waited = 0
        while true {
            if state != before { return true }
            guard waited < withinMs else { return false }
            try? await Task.sleep(nanoseconds: 25_000_000)
            waited += 25
        }
    }

    func selectAll() -> Bool {
        var range = CFRange(location: 0, length: length)
        guard let value = AXValueCreate(.cfRange, &range) else { return false }
        return AXUIElementSetAttributeValue(element, "AXSelectedTextRange" as CFString, value) == .success
    }

    /// Replaces the selection (or inserts at the caret). Only `.ignored` and `.refused` mean
    /// the text is certainly not there, so only they allow trying another way.
    func insert(_ text: String) async -> CUInsertOutcome {
        let before = state
        let accepted = AXUIElementSetAttributeValue(element, "AXSelectedText" as CFString, text as CFString) == .success
        if accepted, text.isEmpty, before.selection?.length == 0 { return .changed }
        if accepted, await changed(since: before, withinMs: 250) { return .changed }
        return cuInsertOutcome(accepted: accepted, before: before, after: state)
    }
}

/// The editing commands emulated for background text, by chord.
enum CUTextCommand { case selectAll, copy, cut, paste }
func cuTextCommand(_ chord: CUChord) -> CUTextCommand? {
    guard chord.named.intersection([.maskCommand, .maskShift, .maskAlternate, .maskControl]) == .maskCommand else { return nil }
    switch chord.keyChar?.lowercased() {
    case "a": return .selectAll
    case "c": return .copy
    case "x": return .cut
    case "v": return .paste
    default: return nil
    }
}

/// Runs an editing command through accessibility. Nil when the app would not take it, so the
/// caller can fall back to the menu or a posted key; never after text may have changed.
@MainActor func cuRunTextCommand(_ command: CUTextCommand, on target: CUTextTarget) async -> String? {
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
        switch await target.insert("") {
        case .changed, .unverified:
            board.clearContents(); board.setString(text, forType: .string)
            return "cut \(text.count) characters"
        case .ignored, .refused: return nil
        }
    case .paste:
        guard let text = board.string(forType: .string) else { return "pasted nothing (the clipboard has no text)" }
        switch await target.insert(text) {
        case .changed: return "pasted \(text.count) characters"
        case .unverified: return "pasted \(text.count) characters (the app does not report its text, so this is unconfirmed)"
        case .ignored, .refused: return nil
        }
    }
}
