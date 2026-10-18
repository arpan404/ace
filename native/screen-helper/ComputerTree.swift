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
    let detail: String?
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
let cuStructuralRoles: Set<String> = ["AXWindow", "AXSheet", "AXDrawer", "AXMenu", "AXTable", "AXOutline", "AXList", "AXTabGroup", "AXToolbar", "AXWebArea", "AXBrowser", "AXPopover", "AXDialog"]

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
    guard let text else { return nil }
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

struct CUTree {
    var nodes: [CUNode] = []
    var truncated = false
}

/// Depth-first walk with a node and time budget, folding unlabeled wrappers.
@MainActor final class CUTreeWalker {
    let registry: CUElementRegistry
    var tree = CUTree()
    private var visited = 0
    private let maxVisited = 6_000
    private let maxNodes = 1_200
    private let deadline: UInt64

    init(registry: CUElementRegistry, budgetMs: UInt64 = 5_000) {
        self.registry = registry
        deadline = DispatchTime.now().uptimeNanoseconds + budgetMs * 1_000_000
    }

    private var exhausted: Bool {
        visited >= maxVisited || tree.nodes.count >= maxNodes || DispatchTime.now().uptimeNanoseconds > deadline
    }

    func walk(_ element: AXUIElement, depth: Int, parentName: String? = nil) {
        if exhausted { tree.truncated = true; return }
        visited += 1
        let attributes = cuFetch(element)
        let role = attributes["AXRole"] as? String ?? "AXUnknown"
        if cuNoiseRoles.contains(role) { return }
        let subrole = attributes["AXSubrole"] as? String
        let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
        let frame = cuFrame(attributes)
        let (children, clipped) = cuChildren(element, limit: role == "AXMenuBar" ? 0 : 400)
        if clipped { tree.truncated = true }
        // Hidden or collapsed parts report zero size; they are not on screen to act on.
        if let frame, frame.width <= 0 || frame.height <= 0, children.isEmpty { return }

        let title = cuClip(attributes["AXTitle"] as? String, 200)
        let description = cuClip(attributes["AXDescription"] as? String, 200)
        var value = secure ? nil : cuClip(cuValueText(attributes["AXValue"]), role == "AXTextArea" || role == "AXStaticText" ? 2_000 : 300)
        var flags: [String] = []
        if (attributes["AXEnabled"] as? Bool) == false { flags.append("disabled") }
        if (attributes["AXSelected"] as? Bool) == true { flags.append("selected") }
        if (attributes["AXFocused"] as? Bool) == true { flags.append("focused") }
        // Chromium reports "collapsed" on every element; only controls that expand say so.
        if let expanded = attributes["AXExpanded"] as? Bool, cuExpandableRoles.contains(role) || subrole == "AXOutlineRow" || expanded {
            flags.append(expanded ? "expanded" : "collapsed")
        }
        if secure { flags.append("secure") }
        if role == "AXCheckBox" || role == "AXRadioButton" || role == "AXSwitch" || subrole == "AXSwitch" || subrole == "AXToggle" {
            if let number = attributes["AXValue"] as? NSNumber { flags.append(number.intValue == 0 ? "off" : number.intValue == 1 ? "on" : "mixed") }
            value = nil
        }
        // Static text carries its words in its value; show them as its name.
        var name = title ?? description
        var detail = title != nil && description != nil && description != title ? description : nil
        if (role == "AXStaticText" || role == "AXHeading"), name == nil, let text = value { name = text; value = nil }
        if value == name { value = nil }
        if detail == name { detail = nil }
        let placeholder = cuTextInputRoles.contains(role) ? cuClip(attributes["AXPlaceholderValue"] as? String, 120) : nil
        let url = role == "AXLink" || role == "AXWebArea" || role == "AXImage" ? cuClip(cuValueText(attributes["AXURL"]), 300) : nil
        let axActions = cuActionNames(element)
        var readable: [String] = []
        for action in axActions { if let label = cuReadableAction(action), !readable.contains(label), readable.count < 6 { readable.append(label) } }
        if role == "AXWindow" || role == "AXSheet" { readable.removeAll { $0 == "raise" } }

        let actionable = axActions.contains("AXPress") || !readable.isEmpty || cuTextInputRoles.contains(role)
            || ["AXRow", "AXCell", "AXOutlineRow", "AXSlider", "AXIncrementor", "AXPopUpButton", "AXMenuButton", "AXDisclosureTriangle", "AXLink", "AXTab", "AXColorWell", "AXDateField"].contains(role)
        let labelled = name != nil || value != nil
        let structural = cuStructuralRoles.contains(role)

        // Drop text that repeats its parent's label (a button's own caption).
        if role == "AXStaticText", children.isEmpty, let name, name == parentName { return }
        if role == "AXImage", !labelled, !actionable { return }

        // Unlabelled wrappers: dropped when empty, folded into their only child, otherwise kept
        // as a plain group so siblings stay visibly grouped.
        let keep: Bool
        if actionable || structural || labelled { keep = true }
        else if children.isEmpty { return }
        else { keep = children.count > 1 }

        var childDepth = depth
        if keep {
            let roleName = cuClip(attributes["AXRoleDescription"] as? String, 40) ?? String(role.dropFirst(2)).lowercased()
            let id = registry.id(for: element)
            tree.nodes.append(CUNode(id: id, depth: depth, role: roleName, flags: flags, name: name, value: value, detail: detail,
                                     placeholder: placeholder, url: url, actions: readable, frame: frame, axActions: axActions, axRole: role))
            childDepth = depth + 1
        }
        for child in children {
            if exhausted { tree.truncated = true; return }
            walk(child, depth: childDepth, parentName: name ?? parentName)
        }
    }
}

/// Top-level menu titles, the entry points for `menu` actions. Never opens a menu.
func cuMenuBarTitles(_ application: AXUIElement) -> [String] {
    guard let bar = cuAttribute(application, "AXMenuBar") else { return [] }
    let items = cuAttribute(bar as! AXUIElement, "AXChildren") as? [AXUIElement] ?? []
    return items.dropFirst().compactMap { cuClip(cuAttribute($0, "AXTitle") as? String, 40) }
}

/// Context menus and popovers open at app level, outside any window.
func cuOpenMenus(_ application: AXUIElement) -> [AXUIElement] {
    (cuAttribute(application, "AXChildren") as? [AXUIElement] ?? []).filter { cuRole($0) == "AXMenu" }
}
