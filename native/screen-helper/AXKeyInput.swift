import ApplicationServices
import Foundation
import ScreenCaptureKit

/// Edit the verified field without invoking the application's key-window responder chain.
func performAXKey(_ element: AXUIElement, code: UInt16, modifiers: [String], beforeDispatch: () -> Void) throws -> Bool {
    let flags = Set(modifiers)
    if flags.isEmpty || flags == ["shift"] {
        let printable = usKeys.first { $0.value.code == code && $0.value.shift == flags.contains("shift") }?.key
        if let printable, !String(printable).unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) {
            beforeDispatch()
            return try replaceAXSelection(element, text: String(printable))
        }
    }
    guard let count = axAttribute(element, kAXNumberOfCharactersAttribute) as? NSNumber, count.intValue >= 0,
          let value = axAttribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return false }
    var range = CFRange()
    guard AXValueGetValue(value as! AXValue, .cfRange, &range), range.location >= 0, range.length >= 0,
          range.location <= count.intValue, range.length <= count.intValue - range.location else { return false }
    if code == 0, flags == ["command"] { range = CFRange(location: 0, length: count.intValue) }
    else if flags.isEmpty {
        // AX offsets are UTF-16. Move by composed characters rather than splitting emoji.
        var text: NSString?
        if [UInt16(123), 124].contains(code), range.length == 0, count.intValue <= 4096 {
            var whole = CFRange(location: 0, length: count.intValue)
            if let parameter = AXValueCreate(.cfRange, &whole) {
                var copied: CFTypeRef?
                if AXUIElementCopyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute as CFString, parameter, &copied) == .success,
                   let string = copied as? String, string.utf16.count == count.intValue { text = string as NSString }
            }
        }
        switch code {
        case 123:
            if range.length == 0 && range.location > 0 {
                guard let text else { return false }
                range.location = text.rangeOfComposedCharacterSequence(at: range.location - 1).location
            }
            range.length = 0
        case 124:
            if range.length > 0 { range.location += range.length }
            else if range.location < count.intValue {
                guard let text else { return false }
                range.location = NSMaxRange(text.rangeOfComposedCharacterSequence(at: range.location))
            }
            range.length = 0
        case 115: range = CFRange(location: 0, length: 0)
        case 119: range = CFRange(location: count.intValue, length: 0)
        // Deletion and vertical navigation need grapheme/layout information; raw fallback is guarded.
        default: return false
        }
    } else { return false }
    guard let encoded = AXValueCreate(.cfRange, &range) else { return false }
    beforeDispatch()
    let result = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, encoded)
    if result == .success { return true }
    guard [.attributeUnsupported, .notImplemented, .actionUnsupported].contains(result) else { throw HelperError("AX selection delivery is unconfirmed", code: "delivery_unconfirmed", phase: "dispatched") }
    return false
}

@MainActor func requireProcessKeyboardDestination(_ window: ScreenCaptureKit.SCWindow, resolver: WindowResolver) throws {
    guard let pid = window.owningApplication?.processID,
          let value = axAttribute(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { throw HelperError("Application has no keyboard responder; use menu.press or open.url", code: "no_key_window") }
    // Some applications route even a correctly window-tagged CGEvent through their key window.
    try resolver.requireDestination(value as! AXUIElement, window: window)
}
