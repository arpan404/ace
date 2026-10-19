import AppKit
import ApplicationServices

/// One meaningful UI element. Structure-only wrappers are folded away by the walker.
struct CUNode {
    let id: Int
    let depth: Int
    let role: String
    let flags: [String]
    let name: String?
    let value: String?
    var detail: String?
    let placeholder: String?
    let url: String?
    let actions: [String]
    let frame: CGRect?
    let axActions: [String]
    let axRole: String

    func json(origin: CGPoint) -> CUObject {
        var object: CUObject = ["id": id, "depth": depth, "role": role]
        if !flags.isEmpty { object["flags"] = flags }
        if let name { object["name"] = name }
        if let value { object["value"] = value }
        if let detail { object["detail"] = detail }
        if let placeholder { object["placeholder"] = placeholder }
        if let url { object["url"] = url }
        if !actions.isEmpty { object["actions"] = actions }
        return object
    }
}

let cuTextInputRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField"]
/// Chrome that only restates what scrolling and layout already do; never worth the tokens.
let cuNoiseRoles: Set<String> = ["AXScrollBar", "AXValueIndicator", "AXRuler", "AXRulerMarker", "AXGrowArea", "AXSplitter", "AXMatte"]
let cuStructuralRoles: Set<String> = ["AXWindow", "AXSheet", "AXDrawer", "AXMenu", "AXTable", "AXOutline", "AXList", "AXTabGroup", "AXToolbar", "AXWebArea", "AXBrowser", "AXPopover", "AXDialog", "AXScrollArea"]

let cuExpandableRoles: Set<String> = ["AXDisclosureTriangle", "AXOutlineRow", "AXComboBox", "AXPopUpButton", "AXMenuButton", "AXRow", "AXDisclosure", "AXTreeItem"]

/// Readable, model-facing names for AX actions. Press is the implicit click and never listed.
func cuReadableAction(_ name: String) -> String? {
    switch name {
    case "AXPress", "AXScrollToVisible", "AXShowDefaultUI", "AXShowAlternateUI": return nil
    case "AXShowMenu": return nil
    case "AXIncrement": return "increment"
    case "AXDecrement": return "decrement"
    case "AXConfirm": return "confirm"
    case "AXCancel": return "cancel"
    case "AXRaise": return "raise"
    case "AXPick": return "pick"
    case "AXOpen": return "open"
    case "AXDelete": return "delete"
    case "AXZoomWindow": return "zoom"
    case "AXScrollLeftByPage", "AXScrollRightByPage", "AXScrollUpByPage", "AXScrollDownByPage": return nil
    default:
        // Custom actions arrive as "Name:Copy\nTarget:0x0\nSelector:(null)".
        if name.hasPrefix("Name:") {
            let label = name.dropFirst(5).split(separator: "\n", maxSplits: 1).first.map(String.init) ?? ""
            return label.isEmpty || label.count > 40 ? nil : label
        }
        return name.hasPrefix("AX") ? String(name.dropFirst(2)).lowercased() : nil
    }
}

func cuClip(_ text: String?, _ limit: Int) -> String? {
    guard var text else { return nil }
    // Only the start is ever shown; never scan a multi-megabyte value whole.
    if text.utf16.count > limit * 4 + 64 { text = String(text.prefix(limit * 2 + 32)) }
    // Bidi marks (Calculator wraps every number in them) are invisible noise for the model.
    let visible = text.unicodeScalars.filter { !(0x200E...0x200F).contains($0.value) && !(0x202A...0x202E).contains($0.value) && !(0x2066...0x2069).contains($0.value) }
    let trimmed = String(String.UnicodeScalarView(visible)).trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return nil }
    return trimmed.count > limit ? String(trimmed.prefix(limit)) + "…" : trimmed
}

func cuValueText(_ value: AnyObject?) -> String? {
    guard let value else { return nil }
    if let string = value as? String { return string }
    if let number = value as? NSNumber { return number.stringValue }
    if let url = value as? URL { return url.absoluteString }
    if CFGetTypeID(value) == CFURLGetTypeID() { return (value as! CFURL as URL).absoluteString }
    return nil
}

/// Top-level menu titles, the entry points for `menu` actions. Never opens a menu.
func cuMenuBarTitles(_ application: AXUIElement) -> [String] {
    guard let bar = cuElementAttribute(application, "AXMenuBar") else { return [] }
    let items = cuAttribute(bar, "AXChildren") as? [AXUIElement] ?? []
    return items.dropFirst().compactMap { cuClip(cuAttribute($0, "AXTitle") as? String, 40) }
}

/// Context menus and popovers open at app level, outside any window.
func cuOpenMenus(_ application: AXUIElement) -> [AXUIElement] {
    (cuAttribute(application, "AXChildren") as? [AXUIElement] ?? []).filter { cuRole($0) == "AXMenu" }
}
