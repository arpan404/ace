import Carbon
import CoreGraphics
import Foundation

/// One physical key with the Shift and Option state that types a character.
struct CUKeyStroke: Hashable {
    let code: CGKeyCode
    let shift: Bool
    let option: Bool
    init(_ code: CGKeyCode, shift: Bool = false, option: Bool = false) { self.code = code; self.shift = shift; self.option = option }
    var flags: CGEventFlags {
        var flags: CGEventFlags = []
        if shift { flags.insert(.maskShift) }
        if option { flags.insert(.maskAlternate) }
        return flags
    }
}

/// What each key of one keyboard layout types with and without Shift and Option, and the
/// reverse: which key types a character. Pure, so chords are tested against a supplied table.
struct CUKeyLayout {
    private var output: [CUKeyStroke: String] = [:]
    private var strokes: [Character: CUKeyStroke] = [:]

    /// Entries in preference order: when two keys type the same character, the first wins.
    init(_ entries: [(CUKeyStroke, String)]) {
        for (stroke, text) in entries where !text.isEmpty {
            output[stroke] = text
            if text.count == 1, let character = text.first, strokes[character] == nil { strokes[character] = stroke }
        }
    }

    func stroke(for character: Character) -> CUKeyStroke? { strokes[character] }
    func text(_ code: CGKeyCode, shift: Bool = false, option: Bool = false) -> String? { output[CUKeyStroke(code, shift: shift, option: option)] }

    /// The US ANSI layout, for when the system offers no layout data.
    static let ansi: CUKeyLayout = {
        let keys: [(CGKeyCode, String, String)] = [
            (0, "a", "A"), (1, "s", "S"), (2, "d", "D"), (3, "f", "F"), (4, "h", "H"), (5, "g", "G"), (6, "z", "Z"), (7, "x", "X"),
            (8, "c", "C"), (9, "v", "V"), (11, "b", "B"), (12, "q", "Q"), (13, "w", "W"), (14, "e", "E"), (15, "r", "R"), (16, "y", "Y"),
            (17, "t", "T"), (18, "1", "!"), (19, "2", "@"), (20, "3", "#"), (21, "4", "$"), (22, "6", "^"), (23, "5", "%"), (24, "=", "+"),
            (25, "9", "("), (26, "7", "&"), (27, "-", "_"), (28, "8", "*"), (29, "0", ")"), (30, "]", "}"), (31, "o", "O"), (32, "u", "U"),
            (33, "[", "{"), (34, "i", "I"), (35, "p", "P"), (37, "l", "L"), (38, "j", "J"), (39, "'", "\""), (40, "k", "K"), (41, ";", ":"),
            (42, "\\", "|"), (43, ",", "<"), (44, "/", "?"), (45, "n", "N"), (46, "m", "M"), (47, ".", ">"), (50, "`", "~"), (49, " ", " "),
        ]
        return CUKeyLayout(keys.map { (CUKeyStroke($0.0), $0.1) } + keys.map { (CUKeyStroke($0.0, shift: true), $0.2) })
    }()
}

/// A key code no Apple layout assigns. Characters no key types are posted on it as Unicode,
/// so apps that read key codes never see a real key such as "a".
let cuNeutralKeyCode: CGKeyCode = 0x46

/// Keypad keys type digits too; the main row is preferred for the reverse map.
private let cuKeypadCodes: Set<CGKeyCode> = [65, 67, 69, 71, 75, 76, 78, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92]

/// The person's current keyboard layout and input method, read through Text Input Sources.
/// TIS must be used on the main thread; layouts are cached per input source id.
@MainActor enum CUKeyboard {
    private static var cached: (id: String, layout: CUKeyLayout)?

    static func current() -> CUKeyLayout {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue() else { return .ansi }
        let id = cuSourceString(source, kTISPropertyInputSourceID) ?? ""
        if let cached, cached.id == id { return cached.layout }
        let layout = cuReadLayout(source) ?? .ansi
        cached = (id, layout)
        return layout
    }

    /// True while an input method (Japanese, Chinese, Korean…) rather than a plain layout is
    /// selected: typed keys would be composed instead of inserted.
    static var inputMethodActive: Bool {
        guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
              let type = cuSourceString(source, kTISPropertyInputSourceType) else { return false }
        return type != (kTISTypeKeyboardLayout as String)
    }
}

/// Parses a chord on the person's current keyboard layout.
@MainActor func cuParseChord(_ input: String) throws -> CUChord { try cuParseChord(input, layout: CUKeyboard.current()) }

private func cuSourceString(_ source: TISInputSource, _ key: CFString) -> String? {
    guard let pointer = TISGetInputSourceProperty(source, key) else { return nil }
    return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
}

private func cuReadLayout(_ source: TISInputSource) -> CUKeyLayout? {
    guard let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
    let data = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
    let keyboardType = UInt32(LMGetKbdType())
    var entries: [(CUKeyStroke, String)] = []
    data.withUnsafeBytes { raw in
        guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
        let combos: [(Bool, Bool)] = [(false, false), (true, false), (false, true), (true, true)]
        let groups = [(0..<CGKeyCode(128)).filter { !cuKeypadCodes.contains($0) }, cuKeypadCodes.sorted()]
        for codes in groups {
            for (shift, option) in combos {
                let state = UInt32(((shift ? shiftKey : 0) | (option ? optionKey : 0)) >> 8) & 0xFF
                for code in codes {
                    var dead: UInt32 = 0
                    var length = 0
                    var chars = [UniChar](repeating: 0, count: 4)
                    let status = UCKeyTranslate(layout, code, UInt16(kUCKeyActionDown), state, keyboardType,
                                                OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &length, &chars)
                    guard status == noErr, length > 0 else { continue }
                    let text = String(utf16CodeUnits: chars, count: length)
                    // Control characters and function-key private-use codes are named keys, not text.
                    guard let scalar = text.unicodeScalars.first, scalar.value >= 0x20, scalar.value != 0x7F,
                          !(0xF700...0xF8FF).contains(scalar.value) else { continue }
                    entries.append((CUKeyStroke(code, shift: shift, option: option), text))
                }
            }
        }
    }
    return entries.isEmpty ? nil : CUKeyLayout(entries)
}
