import AppKit
import ApplicationServices

/// Finds `wanted` in `text` (UTF-16 offsets): the first occurrence with `prefix` right before
/// it and `suffix` right after it. Without anchors, or when anchors match nothing but the text
/// occurs only once, the first occurrence.
func cuFindText(_ wanted: String, in text: String, prefix: String?, suffix: String?) -> NSRange? {
    let haystack = text as NSString
    let length = (wanted as NSString).length
    guard length > 0 else { return nil }
    var occurrences: [NSRange] = []
    var from = 0
    while from < haystack.length {
        let found = haystack.range(of: wanted, range: NSRange(location: from, length: haystack.length - from))
        if found.location == NSNotFound { break }
        occurrences.append(found)
        from = found.location + 1
    }
    let anchored = occurrences.first { range in
        if let prefix, !prefix.isEmpty, !haystack.substring(to: range.location).hasSuffix(prefix) { return false }
        if let suffix, !suffix.isEmpty, !haystack.substring(from: range.location + range.length).hasPrefix(suffix) { return false }
        return true
    }
    return anchored ?? (occurrences.count == 1 ? occurrences[0] : nil)
}

extension CUActor {
    func setValue(_ action: CUObject) throws -> String {
        let target = try element(action)
        if cuIsSecure(target) { throw CUError("secure_field", "That is a password field. Ask the person to fill it in themselves.") }
        let value: CFTypeRef
        if let text = action["value"] as? String { value = text as CFString }
        else if let number = action["value"] as? NSNumber {
            value = CFGetTypeID(number) == CFBooleanGetTypeID() ? (number.boolValue ? 1 : 0) as CFNumber : number
        } else { throw CUError("bad_action", "set_value needs a value (text, number or true/false).") }
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(target, "AXValue" as CFString, &settable) == .success, settable.boolValue else {
            throw CUError("not_settable", "\(label(target))'s value can't be set directly. Click it and type, or use the keyboard.")
        }
        let result = AXUIElementSetAttributeValue(target, "AXValue" as CFString, value)
        guard result == .success else { throw CUError("action_failed", "\(session.name) rejected the new value for \(label(target)) (AX error \(result.rawValue)).") }
        session.settler.markChanged()
        return "set \(label(target))"
    }

    func selectText(_ action: CUObject) throws -> String {
        let target = try element(action)
        guard let wanted = action.string("text"), !wanted.isEmpty else { throw CUError("bad_action", "select_text needs the text to select.") }
        guard let full = cuAttribute(target, "AXValue") as? String else { throw CUError("not_text", "\(label(target)) has no text to select.") }
        guard var range = cuFindText(wanted, in: full, prefix: action.string("prefix"), suffix: action.string("suffix")) else {
            let present = (full as NSString).range(of: wanted).location != NSNotFound
            throw CUError("text_not_found", present
                ? "\"\(cuClip(wanted, 40) ?? "")\" occurs more than once in \(label(target)) and prefix/suffix match none of them. Copy the surrounding text exactly."
                : "\"\(cuClip(wanted, 40) ?? "")\" is not in \(label(target)). Copy the text exactly as the outline shows it.")
        }
        if action.string("cursor") == "after" { range = NSRange(location: range.location + range.length, length: 0) }
        if action.string("cursor") == "before" { range = NSRange(location: range.location, length: 0) }
        _ = try? focus(target)
        var cfRange = CFRange(location: range.location, length: range.length)
        guard let value = AXValueCreate(.cfRange, &cfRange),
              AXUIElementSetAttributeValue(target, "AXSelectedTextRange" as CFString, value) == .success else {
            throw CUError("action_failed", "\(session.name) would not change the selection in \(label(target)).")
        }
        session.settler.markChanged()
        return range.length == 0 ? "placed the cursor in \(label(target))" : "selected \"\(cuClip(wanted, 40) ?? "")\" in \(label(target))"
    }

    /// Performs one of the element's listed actions by its readable or AX name.
    func secondary(_ action: CUObject) async throws -> String {
        let target = try element(action)
        guard let wanted = action.string("name"), !wanted.isEmpty else { throw CUError("bad_action", "action needs the action name shown on the element.") }
        let available = cuActionNames(target)
        let compact = wanted.replacingOccurrences(of: " ", with: "").lowercased()
        let match = available.first { $0 == wanted || cuReadableAction($0)?.lowercased() == wanted.lowercased() || $0.lowercased() == "ax" + compact || $0.lowercased() == compact }
        guard let match else {
            let names = available.compactMap(cuReadableAction)
            throw CUError("unknown_action", "\(label(target)) has no \"\(wanted)\" action. It offers: \(names.isEmpty ? "only a plain click" : names.joined(separator: ", ")).")
        }
        let note = try await perform(target, match)
        return "performed \(cuReadableAction(match) ?? match) on \(label(target))\(note)\(match == "AXShowMenu" ? cuMenuOpenNote : "")"
    }
}
