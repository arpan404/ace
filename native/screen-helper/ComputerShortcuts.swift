import ApplicationServices
import CoreGraphics

/// AX encodes a menu item's modifiers as a bitmask over an implied Command key.
func cuMenuModifierMask(_ flags: CGEventFlags) -> Int? {
    guard flags.contains(.maskCommand) else { return nil }
    var mask = 0
    if flags.contains(.maskShift) { mask |= 1 }
    if flags.contains(.maskAlternate) { mask |= 2 }
    if flags.contains(.maskControl) { mask |= 4 }
    return mask
}

/// Whether a menu item's shortcut is this chord. Letters compare case-insensitively.
func cuShortcutMatches(itemChar: String?, itemVirtualKey: Int?, itemModifiers: Int, chord: CUChord, mask: Int) -> Bool {
    guard itemModifiers == mask else { return false }
    if let itemChar, !itemChar.isEmpty, let text = chord.text { return itemChar.lowercased() == text.lowercased() }
    if let itemVirtualKey { return itemVirtualKey == Int(chord.code) }
    return false
}

/// The menu item bound to a ⌘ shortcut. Apps in the background ignore posted ⌘ keys, but
/// pressing the menu item does the same thing without bringing them forward.
func cuMenuItem(for chord: CUChord, in application: AXUIElement) -> AXUIElement? {
    guard let mask = cuMenuModifierMask(chord.flags), let bar = cuAttribute(application, "AXMenuBar") else { return nil }
    let started = DispatchTime.now().uptimeNanoseconds
    var stack: [AXUIElement] = [bar as! AXUIElement]
    var visited = 0
    while let element = stack.popLast(), visited < 3_000, DispatchTime.now().uptimeNanoseconds - started < 1_500_000_000 {
        visited += 1
        let role = cuRole(element)
        if role == "AXMenuItem" {
            let char = cuAttribute(element, "AXMenuItemCmdChar") as? String
            let key = (cuAttribute(element, "AXMenuItemCmdVirtualKey") as? NSNumber)?.intValue
            let modifiers = (cuAttribute(element, "AXMenuItemCmdModifiers") as? NSNumber)?.intValue ?? 0
            // AXEnabled is stale until the menu is next drawn; the app validates on press.
            if cuShortcutMatches(itemChar: char, itemVirtualKey: key, itemModifiers: modifiers, chord: chord, mask: mask) { return element }
        }
        stack.append(contentsOf: (cuAttribute(element, "AXChildren") as? [AXUIElement] ?? []).reversed())
    }
    return nil
}
