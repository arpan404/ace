import ApplicationServices
import Foundation

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
        for character in text {
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
