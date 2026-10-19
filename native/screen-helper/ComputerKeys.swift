import CoreGraphics
import Foundation

/// A parsed chord such as "cmd+shift+n": one key plus modifier flags.
struct CUChord: Equatable {
    let code: CGKeyCode
    /// Flags on the posted event, including a Shift or Option the character needs.
    let flags: CGEventFlags
    /// The characters the event carries, when the key types something.
    let text: String?
    /// The modifiers the caller named. Menu shortcuts compare against these.
    let named: CGEventFlags
    /// The character the key stands for in a shortcut, as AppKit's charactersIgnoringModifiers
    /// reports it: "+" for cmd++, "A" for cmd+shift+a.
    let keyChar: String?

    init(code: CGKeyCode, flags: CGEventFlags, text: String?, named: CGEventFlags? = nil, keyChar: String? = nil) {
        self.code = code
        self.flags = flags
        self.text = text
        self.named = named ?? flags
        self.keyChar = keyChar ?? text
    }

    /// Command or Control: the key is a shortcut, not typing.
    var isShortcut: Bool { !named.intersection([.maskCommand, .maskControl]).isEmpty }
    /// Typing that inserts visible text into a field.
    var typesText: Bool {
        guard !isShortcut, let text, let scalar = text.unicodeScalars.first else { return false }
        return scalar.value >= 0x20 && scalar.value != 0x7F
    }
}

let cuNamedKeys: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 51, "escape": 53, "esc": 53,
    "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
    "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64,
    "f18": 79, "f19": 80, "f20": 90,
]

/// Names for characters that are awkward inside a chord.
private let cuCharacterNames: [String: Character] = ["plus": "+", "minus": "-", "comma": ",", "period": ".", "slash": "/", "backslash": "\\"]

/// Parse "cmd+shift+n", "Return", "ctrl+alt+Delete" or a single character, using `layout` to
/// find the key that types a character and what the key types with Shift or Option.
func cuParseChord(_ input: String, layout: CUKeyLayout) throws -> CUChord {
    let trimmed = input.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty, trimmed.count <= 64 else { throw CUError("bad_key", "Key is empty or too long. Use names like \"cmd+n\", \"Return\", \"Escape\", \"Down\".") }
    // "+" alone, or a chord ending in "+" (cmd++), means the plus key.
    var parts = trimmed.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    if trimmed == "+" { parts = ["+"] }
    else if trimmed.hasSuffix("++") { parts = Array(parts.dropLast(2)) + ["+"] }
    var named: CGEventFlags = []
    for modifier in parts.dropLast() {
        switch modifier.lowercased() {
        case "cmd", "command", "super", "meta", "win": named.insert(.maskCommand)
        case "shift": named.insert(.maskShift)
        case "alt", "option", "opt": named.insert(.maskAlternate)
        case "ctrl", "control": named.insert(.maskControl)
        case "fn": named.insert(.maskSecondaryFn)
        default: throw CUError("bad_key", "Unknown modifier \"\(modifier)\". Use cmd, shift, alt (option), ctrl or fn.")
        }
    }
    guard let key = parts.last, !key.isEmpty else { throw CUError("bad_key", "Missing key after the modifiers in \"\(input)\".") }
    if key.count > 1, let code = cuNamedKeys[key.lowercased()] {
        let shift = named.contains(.maskShift)
        // Shift+Tab types back-tab (U+0019), which is what text views read as "previous field".
        let text: String? = code == 36 ? "\r" : code == 48 ? (shift ? "\u{19}" : "\t") : code == 49 ? " " : nil
        return CUChord(code: code, flags: named, text: text, named: named, keyChar: code == 49 ? " " : nil)
    }
    let character: Character
    if key.count == 1, let only = key.first { character = only }
    else if let alias = cuCharacterNames[key.lowercased()] { character = alias }
    else {
        throw CUError("bad_key", "Unknown key \"\(key)\". Use one character or a name such as Return, Tab, Escape, Backspace, Up, Down, Left, Right, Home, End, PageUp, PageDown, F1-F20.")
    }
    return cuCharacterChord(character, named: named, layout: layout)
}

private func cuCharacterChord(_ character: Character, named: CGEventFlags, layout: CUKeyLayout) -> CUChord {
    let shortcut = !named.intersection([.maskCommand, .maskControl]).isEmpty
    // In a shortcut a capital letter names the key ("cmd+S" is save); Shift must be said.
    var lookup = character
    if shortcut, character.isLetter, character.isUppercase, let lower = character.lowercased().first, layout.stroke(for: lower) != nil { lookup = lower }
    guard let stroke = layout.stroke(for: lookup) else {
        // No key types it on this layout: post it as Unicode on a key that means nothing.
        return CUChord(code: cuNeutralKeyCode, flags: named, text: String(character), named: named, keyChar: String(character))
    }
    let flags = named.union(stroke.flags)
    let shift = flags.contains(.maskShift)
    if shortcut {
        // AppKit matches shortcuts on what the key types with Shift only (Option is ignored).
        let keyChar = layout.text(stroke.code, shift: shift, option: stroke.option) ?? String(lookup)
        return CUChord(code: stroke.code, flags: flags, text: keyChar, named: named, keyChar: keyChar)
    }
    let text = layout.text(stroke.code, shift: shift, option: flags.contains(.maskAlternate)) ?? String(character)
    return CUChord(code: stroke.code, flags: flags, text: text, named: named, keyChar: text)
}

/// What to post for typed text: runs of characters as Unicode chunks, newlines and tabs as keys.
enum CUTypingStep: Equatable {
    case text(String)
    case key(CGKeyCode, String)
}

/// Splits text into steps; each text chunk holds at most `chunk` UTF-16 units and never splits
/// a character (an emoji sequence longer than `chunk` goes alone).
func cuTypingPlan(_ text: String, chunk: Int) -> [CUTypingStep] {
    var steps: [CUTypingStep] = []
    var run = ""
    var units = 0
    func flush() { if !run.isEmpty { steps.append(.text(run)); run = ""; units = 0 } }
    for character in text {
        switch character {
        case "\n", "\r", "\r\n": flush(); steps.append(.key(36, "\r"))
        case "\t": flush(); steps.append(.key(48, "\t"))
        default:
            let size = character.utf16.count
            if units > 0, units + size > max(1, chunk) { flush() }
            run.append(character)
            units += size
        }
    }
    flush()
    return steps
}
