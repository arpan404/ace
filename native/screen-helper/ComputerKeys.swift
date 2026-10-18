import CoreGraphics
import Foundation

/// A parsed chord such as "cmd+shift+n": one key plus modifier flags.
struct CUChord: Equatable {
    let code: CGKeyCode
    let flags: CGEventFlags
    /// The character the key produces, when it produces one.
    let text: String?
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.code == rhs.code && lhs.flags == rhs.flags && lhs.text == rhs.text }
}

/// macOS virtual key codes for the ANSI layout. Characters outside this table are typed as
/// Unicode with no key code.
let cuCharacterKeys: [Character: (CGKeyCode, Bool)] = {
    var table: [Character: (CGKeyCode, Bool)] = [:]
    let plain: [(Character, CGKeyCode)] = [
        ("a", 0), ("s", 1), ("d", 2), ("f", 3), ("h", 4), ("g", 5), ("z", 6), ("x", 7), ("c", 8), ("v", 9),
        ("b", 11), ("q", 12), ("w", 13), ("e", 14), ("r", 15), ("y", 16), ("t", 17), ("1", 18), ("2", 19),
        ("3", 20), ("4", 21), ("6", 22), ("5", 23), ("=", 24), ("9", 25), ("7", 26), ("-", 27), ("8", 28),
        ("0", 29), ("]", 30), ("o", 31), ("u", 32), ("[", 33), ("i", 34), ("p", 35), ("l", 37), ("j", 38),
        ("'", 39), ("k", 40), (";", 41), ("\\", 42), (",", 43), ("/", 44), ("n", 45), ("m", 46), (".", 47),
        ("`", 50), (" ", 49),
    ]
    let shifted: [(Character, Character)] = [
        ("!", "1"), ("@", "2"), ("#", "3"), ("$", "4"), ("%", "5"), ("^", "6"), ("&", "7"), ("*", "8"),
        ("(", "9"), (")", "0"), ("_", "-"), ("+", "="), ("{", "["), ("}", "]"), ("|", "\\"), (":", ";"),
        ("\"", "'"), ("<", ","), (">", "."), ("?", "/"), ("~", "`"),
    ]
    for (character, code) in plain { table[character] = (code, false) }
    for (character, base) in shifted { if let (code, _) = table[base] { table[character] = (code, true) } }
    for (character, code) in plain where character.isLetter { table[Character(character.uppercased())] = (code, true) }
    return table
}()

let cuNamedKeys: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 51, "escape": 53, "esc": 53,
    "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101,
    "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64,
    "f18": 79, "f19": 80, "f20": 90, "plus": 24, "minus": 27,
]

/// Parse "cmd+shift+n", "Return", "ctrl+alt+Delete" or a single character.
func cuParseChord(_ input: String) throws -> CUChord {
    let trimmed = input.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty, trimmed.count <= 64 else { throw CUError("bad_key", "Key is empty or too long. Use names like \"cmd+n\", \"Return\", \"Escape\", \"Down\".") }
    // "+" alone, or a chord ending in "+" (cmd++), means the plus key.
    var parts = trimmed.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    if trimmed == "+" { parts = ["+"] }
    else if trimmed.hasSuffix("++") { parts = Array(parts.dropLast(2)) + ["+"] }
    var flags: CGEventFlags = []
    for modifier in parts.dropLast() {
        switch modifier.lowercased() {
        case "cmd", "command", "super", "meta", "win": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: throw CUError("bad_key", "Unknown modifier \"\(modifier)\". Use cmd, shift, alt (option), ctrl or fn.")
        }
    }
    guard let key = parts.last, !key.isEmpty else { throw CUError("bad_key", "Missing key after the modifiers in \"\(input)\".") }
    if let code = cuNamedKeys[key.lowercased()], key.count > 1 {
        let text: String? = code == 36 ? "\r" : code == 48 ? "\t" : code == 49 ? " " : nil
        return CUChord(code: code, flags: flags, text: text)
    }
    guard key.count == 1, let character = key.first else {
        throw CUError("bad_key", "Unknown key \"\(key)\". Use one character or a name such as Return, Tab, Escape, Backspace, Up, Down, Left, Right, Home, End, PageUp, PageDown, F1-F20.")
    }
    if let (code, shifted) = cuCharacterKeys[character] {
        // With command or control the base character keeps shortcuts layout-independent.
        if shifted { flags.insert(.maskShift) }
        let produced = flags.contains(.maskCommand) || flags.contains(.maskControl) ? String(character).lowercased() : String(character)
        return CUChord(code: code, flags: flags, text: produced)
    }
    return CUChord(code: 0, flags: flags, text: String(character))
}

/// Split text into what to post: printable runs as characters, newlines and tabs as keys.
enum CUTypingStep: Equatable { case character(Character), key(CGKeyCode) }
func cuTypingSteps(_ text: String) -> [CUTypingStep] {
    text.map { character in
        switch character {
        case "\n", "\r", "\r\n": return .key(36)
        case "\t": return .key(48)
        default: return .character(character)
        }
    }
}
