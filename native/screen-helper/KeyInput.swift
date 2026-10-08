import AppKit

struct NamedKey { let code: UInt16; let modifiers: [String] }
func namedKey(_ name: String, modifiers: [String]) throws -> NamedKey {
    guard modifiers.count <= 4 else { throw HelperError("Modifier limit exceeded", code: "bounds") }
    var normalized = try modifiers.map { modifier -> String in
        switch modifier.lowercased() {
        case "command", "meta", "super": return "command"
        case "option", "alt": return "option"
        case "shift", "control": return modifier.lowercased()
        default: throw HelperError("Unsupported modifier: \(modifier)", code: "modifier_unsupported")
        }
    }
    normalized = normalized.reduce(into: []) { result, modifier in if !result.contains(modifier) { result.append(modifier) } }
    let aliases: [String: UInt16] = ["enter":36,"return":36,"tab":48,"space":49,"backspace":51,"escape":53,"esc":53,"delete":117,"home":115,"end":119,"pageup":116,"pagedown":121,"left":123,"arrowleft":123,"right":124,"arrowright":124,"down":125,"arrowdown":125,"up":126,"arrowup":126,
        "f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,"f9":101,"f10":109,"f11":103,"f12":111,"f13":105,"f14":107,"f15":113,"f16":106,"f17":64,"f18":79,"f19":80,"f20":90]
    if let code = aliases[name.lowercased()] { return NamedKey(code: code, modifiers: normalized) }
    if name.count == 1, let character = name.first, let key = usKeys[character] {
        if key.shift && !normalized.contains("shift") { normalized.append("shift") }
        return NamedKey(code: key.code, modifiers: normalized)
    }
    throw HelperError("Unsupported key: \(name). Use text.type for Unicode text", code: "key_unsupported")
}
