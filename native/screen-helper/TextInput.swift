import ApplicationServices
import Foundation
import ScreenCaptureKit

/// Unknown includes transport errors and missing/unreadable security metadata.
enum TextSecurity { case ordinary, secure, unknown }
struct TextDestination {
    let element: AXUIElement
    let security: TextSecurity
    func requireConsent(_ allowed: Bool) throws {
        if security == .unknown { throw HelperError("Cannot classify text destination", code: "secure_input_required") }
        if security == .secure && !allowed { throw HelperError("Secure text requires session consent", code: "secure_input_required") }
    }
}

@MainActor struct ValidatedTextInput {
    let destination: () throws -> TextDestination
    let replaceSelection: (AXUIElement, String) throws -> Bool
    let postCharacter: (Character) throws -> Void
    var clock: () -> UInt64 = { 0 }
    func type(_ text: String, secureAllowed: Bool) throws {
        // Tab/escape/return control characters can navigate or submit a field. Newlines are
        // literal only through AX selection replacement; fallback never posts them as keys.
        guard !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) && $0.value != 10 }) else {
            throw HelperError("Text contains focus-changing controls; use separate key actions", code: "bounds")
        }
        let original = try destination()
        try original.requireConsent(secureAllowed)
        if text.isEmpty { return }
        if try replaceSelection(original.element, text) { return }
        guard !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw HelperError("Multiline text requires AX selected text support", code: "foreground_required")
        }
        guard text.count <= 256 else { throw HelperError("Destination lacks AX text support; send at most 256 characters per fallback action", code: "bounds") }
        let started = clock()
        for character in text {
            guard clock() - started < 1_000_000_000 else { throw HelperError("Text fallback stopped at its dispatch budget; inspect partial text before continuing", code: "delivery_unconfirmed", phase: "partial") }
            let current = try destination()
            try current.requireConsent(secureAllowed)
            guard CFEqual(original.element, current.element) else { throw HelperError("Text destination changed", code: "focus_changed") }
            try postCharacter(character)
        }
    }
}

func textSecurity(_ element: AXUIElement) -> TextSecurity {
    var roleValue: CFTypeRef?, subroleValue: CFTypeRef?
    let roleStatus = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleValue)
    let subroleStatus = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subroleValue)
    let role = roleValue as? String, subrole = subroleValue as? String
    return classifyTextMetadata(role: role, subrole: subrole,
        roleRead: roleStatus == .success,
        subroleRead: (subroleStatus == .success && subrole != nil) || subroleStatus == .attributeUnsupported || subroleStatus == .noValue)
}

func classifyTextMetadata(role: String?, subrole: String?, roleRead: Bool, subroleRead: Bool) -> TextSecurity {
    if roleRead && role == "AXSecureTextField" || subroleRead && subrole == "AXSecureTextField" { return .secure }
    guard roleRead, let role, role.hasPrefix("AX"), role != "AXUnknown", !role.isEmpty, subroleRead else { return .unknown }
    return .ordinary
}

/// Resolve a field inside this window, never substitute another window's focused field.
@MainActor func windowTextDestination(_ window: ScreenCaptureKit.SCWindow, resolver: WindowResolver, foreground: Bool, clock: () -> UInt64) throws -> TextDestination {
    guard let pid = window.owningApplication?.processID else { throw HelperError("Window owner is gone", code: "target_gone") }
    let root = try resolver.resolve(window)
    if let field = try resolver.cachedField(window) { return TextDestination(element: field, security: textSecurity(field)) }
    let application = AXUIElementCreateApplication(pid)
    for source in [root, application] {
        if let value = axAttribute(source, kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID(),
           let containing = containingAXWindow(value as! AXUIElement), (try? resolver.identity(containing, pid: pid)) == window.windowID {
            let field = value as! AXUIElement
            resolver.rememberField(field, window: window)
            return TextDestination(element: field, security: textSecurity(field))
        }
    }
    // Some AppKit apps expose per-window responders only as AXFocused on descendants.
    let start = clock()
    var stack = [root], visited = 0, matches: [AXUIElement] = []
    while let element = stack.popLast(), visited < 64, clock() - start < 50_000_000 {
        visited += 1
        if axAttribute(element, kAXFocusedAttribute) as? Bool == true,
           ["AXTextField", "AXTextArea", "AXComboBox", "AXSecureTextField"].contains(axAttribute(element, kAXRoleAttribute) as? String ?? "") { matches.append(element) }
        stack.append(contentsOf: axChildren(element, maximum: max(0, 64 - visited - stack.count)))
    }
    guard matches.count == 1, let field = matches.first else { throw HelperError("Selected window has no verified keyboard destination; use ui.act focus or menu.press", code: "no_key_window") }
    try resolver.requireDestination(field, window: window)
    resolver.rememberField(field, window: window)
    return TextDestination(element: field, security: textSecurity(field))
}

/// AXSelectedText is preferred. Whole-value fallback is bounded and preserves selection semantics.
func replaceAXSelection(_ element: AXUIElement, text: String) throws -> Bool {
    let selected = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString)
    if selected == .success { return true }
    guard [.attributeUnsupported, .notImplemented, .actionUnsupported].contains(selected) else { throw HelperError("AX text delivery was not acknowledged; inspect before retrying", code: "delivery_unconfirmed", phase: "dispatched") }
    guard let count = axAttribute(element, kAXNumberOfCharactersAttribute) as? NSNumber, (0...4096).contains(count.intValue),
          let rangeValue = axAttribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(rangeValue) == AXValueGetTypeID() else { return false }
    var selection = CFRange()
    guard AXValueGetValue(rangeValue as! AXValue, .cfRange, &selection), selection.location >= 0, selection.length >= 0,
          selection.location <= count.intValue, selection.length <= count.intValue - selection.location else { return false }
    var range = CFRange(location: 0, length: count.intValue)
    guard let parameter = AXValueCreate(.cfRange, &range) else { return false }
    var value: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute as CFString, parameter, &value) == .success,
          let original = value as? String, original.utf16.count == count.intValue else { return false }
    let units = Array(original.utf16)
    let updated = String(decoding: units.prefix(selection.location), as: UTF16.self) + text + String(decoding: units.dropFirst(selection.location + selection.length), as: UTF16.self)
    guard updated.utf16.count <= 8192 else { return false }
    let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, updated as CFString)
    if result == .success { return true }
    guard [.attributeUnsupported, .notImplemented, .actionUnsupported].contains(result) else { throw HelperError("AX value delivery was not acknowledged; inspect before retrying", code: "delivery_unconfirmed", phase: "dispatched") }
    return false
}
