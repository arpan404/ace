import ApplicationServices
import CoreGraphics

/// AX encodes a menu item's modifiers as a bitmask over an implied Command key: Shift 1,
/// Option 2, Control 4, and 8 when the shortcut has no Command. Only Command or Control
/// chords map to menu items; plain keys are typing.
func cuMenuModifierMask(_ named: CGEventFlags) -> Int? {
    let command = named.contains(.maskCommand)
    guard command || named.contains(.maskControl) else { return nil }
    var mask = command ? 0 : 8
    if named.contains(.maskShift) { mask |= 1 }
    if named.contains(.maskAlternate) { mask |= 2 }
    if named.contains(.maskControl) { mask |= 4 }
    return mask
}

/// Whether a menu item's shortcut is this chord. AX reports letter shortcuts in capitals with
/// Shift in the mask, so letters compare case-insensitively with exact modifiers. Symbols
/// compare exactly, ignoring the Shift that typing the symbol needs ("+" is ⇧= on US keys).
func cuShortcutMatches(itemChar: String?, itemVirtualKey: Int?, itemModifiers: Int, chord: CUChord) -> Bool {
    guard let mask = cuMenuModifierMask(chord.named) else { return false }
    // Arrows, Delete, Return and friends arrive as control or private-use characters.
    if let scalar = itemChar?.unicodeScalars.first, let code = cuFunctionKeyCode(scalar) {
        return itemModifiers == mask && code == chord.code
    }
    if let itemChar, !itemChar.isEmpty {
        guard let key = chord.keyChar, !key.isEmpty else { return false }
        if itemChar.count == 1, itemChar.first?.isLetter == true { return itemModifiers == mask && itemChar.lowercased() == key.lowercased() }
        return itemChar == key && (itemModifiers & ~1) == (mask & ~1)
    }
    if let itemVirtualKey { return itemModifiers == mask && itemVirtualKey == Int(chord.code) }
    return false
}

/// The key a menu shortcut's control or function-key character stands for.
func cuFunctionKeyCode(_ scalar: Unicode.Scalar) -> CGKeyCode? {
    switch scalar.value {
    case 0x08, 0x7F: return 51
    case 0x0D, 0x03: return 36
    case 0x09: return 48
    case 0x1B: return 53
    case 0xF700: return 126
    case 0xF701: return 125
    case 0xF702: return 123
    case 0xF703: return 124
    case 0xF728: return 117
    case 0xF729: return 115
    case 0xF72B: return 119
    case 0xF72C: return 116
    case 0xF72D: return 121
    case 0xF704...0xF717: return [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90][Int(scalar.value - 0xF704)]
    default: return nil
    }
}

private let cuMenuItemAttributes = ["AXRole", "AXMenuItemCmdChar", "AXMenuItemCmdVirtualKey", "AXMenuItemCmdModifiers", "AXChildren"]

/// The menu item bound to a ⌘ shortcut. Apps in the background ignore posted ⌘ keys, but
/// pressing the menu item does the same thing without bringing them forward. One AX round
/// trip per menu element.
func cuMenuItem(for chord: CUChord, in application: AXUIElement) -> AXUIElement? {
    guard cuMenuModifierMask(chord.named) != nil, let bar = cuAttribute(application, "AXMenuBar") else { return nil }
    let started = DispatchTime.now().uptimeNanoseconds
    var stack: [AXUIElement] = [bar as! AXUIElement]
    var visited = 0
    while let element = stack.popLast(), visited < 3_000, DispatchTime.now().uptimeNanoseconds - started < 1_500_000_000 {
        visited += 1
        var values: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(element, cuMenuItemAttributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
              let array = values as? [AnyObject], array.count == cuMenuItemAttributes.count else { continue }
        if array[0] as? String == "AXMenuItem" {
            // AXEnabled is stale until the menu is next drawn; the app validates on press.
            if cuShortcutMatches(itemChar: array[1] as? String, itemVirtualKey: (array[2] as? NSNumber)?.intValue,
                                 itemModifiers: (array[3] as? NSNumber)?.intValue ?? 0, chord: chord) { return element }
        }
        stack.append(contentsOf: (array[4] as? [AXUIElement] ?? []).reversed())
    }
    return nil
}
