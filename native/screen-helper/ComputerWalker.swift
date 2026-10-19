import AppKit
import ApplicationServices

struct CUTree {
    var nodes: [CUNode] = []
    var truncated = false
    /// The app stopped answering mid-walk; the outline is partial.
    var notResponding = false
    /// Elements read and time spent in attribute and action reads, for timings.
    var visited = 0
    var fetchNs: UInt64 = 0
    var actionNs: UInt64 = 0
}

/// Roles whose children are recycled views (rows, cells): their ids follow content.
private let cuCollectionRoles: Set<String> = ["AXTable", "AXOutline", "AXList", "AXGrid", "AXBrowser"]
private let cuRowRoles: Set<String> = ["AXRow", "AXOutlineRow"]
private let cuAlwaysActionable: Set<String> = ["AXRow", "AXCell", "AXOutlineRow", "AXSlider", "AXIncrementor", "AXPopUpButton", "AXMenuButton", "AXDisclosureTriangle", "AXLink", "AXTab", "AXColorWell", "AXDateField"]

/// Read for every element: enough to clip it, drop it or descend into it.
let cuShapeAttributes = ["AXRole", "AXPosition", "AXSize", "AXChildren"]

private let cuPlainRoles: Set<String> = ["AXStaticText", "AXGroup", "AXImage", "AXHeading", "AXScrollArea", "AXSplitGroup", "AXWindow", "AXLayoutArea", "AXWebArea", "AXList", "AXTable", "AXOutline", "AXCell"]
private let cuSelectableRoles: Set<String> = ["AXRow", "AXOutlineRow", "AXCell", "AXTab", "AXRadioButton", "AXMenuItem", "AXMenuBarItem", "AXGroup", "AXImage", "AXStaticText"]
private let cuSubroleRoles: Set<String> = ["AXTextField", "AXCheckBox", "AXRadioButton", "AXRow", "AXButton", "AXGroup", "AXWindow"]
/// Roles whose description never depends on the subrole, so one read per session serves all.
let cuFixedDescriptionRoles: Set<String> = ["AXStaticText", "AXCell", "AXTextArea", "AXScrollArea", "AXSplitGroup", "AXImage", "AXSlider", "AXPopUpButton", "AXComboBox", "AXIncrementor", "AXProgressIndicator", "AXHeading", "AXColumn"]

/// Read for elements that may appear in the outline: only what their role can show. Every
/// attribute costs the app time, so roles that never use one don't ask for it. Focus is not
/// read per element; the walker compares with the app's focused element instead.
func cuDetailAttributes(role: String, needsRoleDescription: Bool) -> [String] {
    var names = ["AXTitle", "AXDescription", "AXValue"]
    if !cuPlainRoles.contains(role) { names.append("AXEnabled") }
    if cuSelectableRoles.contains(role) { names.append("AXSelected") }
    if cuExpandableRoles.contains(role) || role == "AXButton" || role == "AXGroup" || role == "AXLink" { names.append("AXExpanded") }
    if cuSubroleRoles.contains(role) { names.append("AXSubrole") }
    if needsRoleDescription { names.append("AXRoleDescription") }
    if cuTextInputRoles.contains(role) { names.append("AXPlaceholderValue") }
    if role == "AXLink" || role == "AXWebArea" || role == "AXImage" { names.append("AXURL") }
    if role == "AXRow" || role == "AXOutlineRow" { names.append("AXIndex") }
    return names
}

/// What a subtree inherits from its ancestors during a walk.
struct CUWalkContext {
    var parentName: String?
    /// What the window or enclosing scroll area shows; nil means nothing is clipped.
    var visible: CGRect?
    var inCollection = false
    var rowIndex: Int?
    /// The nearest kept ancestor node, which carries "N more items above/below".
    var summaryNode: Int?
}

/// Depth-first walk of one window with node, element and time budgets. Reads every attribute
/// an element needs in one round trip, skips what is scrolled out of view (saying how much),
/// never visits an element twice, and stops at the first sign the app is hung.
@MainActor final class CUTreeWalker {
    let registry: CUElementRegistry
    var tree = CUTree()
    private var visited = 0
    private var seen = Set<CUElementKey>()
    private let maxVisited = 6_000
    private let maxNodes = 1_200
    private let deadline: UInt64
    /// The app's focused element, read once per walk.
    private let focused: AXUIElement?

    init(registry: CUElementRegistry, deadline: UInt64, focused: AXUIElement? = nil) {
        self.registry = registry
        self.deadline = deadline
        self.focused = focused
    }

    private var exhausted: Bool {
        tree.notResponding || visited >= maxVisited || tree.nodes.count >= maxNodes || cuNow() > deadline
    }

    @discardableResult
    func walk(_ element: AXUIElement, depth: Int, context: CUWalkContext = CUWalkContext()) -> CUVisibility {
        if exhausted { tree.truncated = true; return .visible }
        guard seen.insert(CUElementKey(element: element)).inserted else { return .visible }
        visited += 1
        tree.visited = visited
        // Two reads: geometry first, so what is scrolled away or pure chrome costs five
        // attributes; then only the attributes this role can use.
        let fetchStarted = cuNow()
        let (shape, status) = cuFetchStatus(element, cuShapeAttributes)
        tree.fetchNs += cuNow() - fetchStarted
        if status == .cannotComplete { tree.notResponding = true; tree.truncated = true; return .visible }
        let role = shape["AXRole"] as? String ?? "AXUnknown"
        if cuNoiseRoles.contains(role) { return .visible }
        let frame = cuFrame(shape)
        if let visible = context.visible, role != "AXWindow" {
            let placement = cuVisibility(of: frame, in: visible)
            if placement != .visible { return placement }
        }
        let (children, hiddenAbove, hiddenBelow) = childList(element, role: role, attributes: shape, visible: context.visible)
        // Hidden or collapsed parts report zero size; they are not on screen to act on.
        if let frame, frame.width <= 0 || frame.height <= 0, children.isEmpty { return .visible }
        let knownDescription = cuFixedDescriptionRoles.contains(role) ? registry.roleDescriptions[role] : nil
        let detailStarted = cuNow()
        var (attributes, detailStatus) = cuFetchStatus(element, cuDetailAttributes(role: role, needsRoleDescription: knownDescription == nil))
        tree.fetchNs += cuNow() - detailStarted
        if detailStatus == .cannotComplete { tree.notResponding = true; tree.truncated = true; return .visible }
        attributes.merge(shape) { current, _ in current }
        if let knownDescription { attributes["AXRoleDescription"] = knownDescription as NSString }
        else if cuFixedDescriptionRoles.contains(role), let fetched = attributes["AXRoleDescription"] as? String { registry.roleDescriptions[role] = fetched }

        let subrole = attributes["AXSubrole"] as? String
        let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
        let title = cuClip(attributes["AXTitle"] as? String, 200)
        let description = cuClip(attributes["AXDescription"] as? String, 200)
        var value = secure ? nil : valueText(element, role: role, raw: cuValueText(attributes["AXValue"]))
        var flags: [String] = []
        if (attributes["AXEnabled"] as? Bool) == false { flags.append("disabled") }
        if (attributes["AXSelected"] as? Bool) == true { flags.append("selected") }
        if let focused, CFEqual(focused, element) { flags.append("focused") }
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
        if role == "AXStaticText" || role == "AXHeading", name == nil, let text = value { name = text; value = nil }
        if value == name { value = nil }
        if detail == name { detail = nil }
        let placeholder = cuTextInputRoles.contains(role) ? cuClip(attributes["AXPlaceholderValue"] as? String, 120) : nil
        let url = role == "AXLink" || role == "AXWebArea" || role == "AXImage" ? cuClip(cuValueText(attributes["AXURL"]), 300) : nil
        // Plain text never acts on its own; skipping its action list saves a round trip per line.
        let actionStarted = cuNow()
        let axActions = role == "AXStaticText" ? [] : cuActionNames(element)
        tree.actionNs += cuNow() - actionStarted
        var readable: [String] = []
        for action in axActions { if let label = cuReadableAction(action), !readable.contains(label), readable.count < 6 { readable.append(label) } }
        if role == "AXWindow" || role == "AXSheet" { readable.removeAll { $0 == "raise" } }

        let actionable = axActions.contains("AXPress") || !readable.isEmpty || cuTextInputRoles.contains(role) || cuAlwaysActionable.contains(role)
        let labelled = name != nil || value != nil

        // Drop text that repeats its parent's label (a button's own caption).
        if role == "AXStaticText", children.isEmpty, let name, name == context.parentName { return .visible }
        if role == "AXImage", !labelled, !actionable { return .visible }

        // Unlabelled wrappers: dropped when empty, folded into their only child, otherwise kept
        // as a plain group so siblings stay visibly grouped.
        let keep: Bool
        if actionable || cuStructuralRoles.contains(role) || labelled { keep = true }
        else if children.isEmpty { return .visible }
        else { keep = children.count > 1 }

        var inner = context
        inner.parentName = name ?? context.parentName
        if role == "AXScrollArea", let frame, frame.width > 0, frame.height > 0 {
            inner.visible = context.visible.map { $0.intersection(frame) } ?? frame
        }
        if cuCollectionRoles.contains(role) { inner.inCollection = true }
        if cuRowRoles.contains(role) { inner.rowIndex = (attributes["AXIndex"] as? NSNumber)?.intValue }

        var childDepth = depth
        if keep {
            let roleName = cuClip(attributes["AXRoleDescription"] as? String, 40) ?? String(role.dropFirst(2)).lowercased()
            // Recycled row views: an id names what the row shows, not the view object.
            let fingerprint = context.inCollection || cuRowRoles.contains(role) ? "\(role)|\(inner.rowIndex ?? -1)|\(name ?? "")" : nil
            let id = registry.id(for: element, fingerprint: fingerprint)
            tree.nodes.append(CUNode(id: id, depth: depth, role: roleName, flags: flags, name: name, value: value, detail: detail,
                                     placeholder: placeholder, url: url, actions: readable, frame: frame, axActions: axActions, axRole: role))
            inner.summaryNode = tree.nodes.count - 1
            childDepth = depth + 1
        }
        var above = hiddenAbove, below = hiddenBelow
        for child in children {
            if exhausted { tree.truncated = true; break }
            switch walk(child, depth: childDepth, context: inner) {
            case .above: above += 1
            case .below: below += 1
            case .visible, .beside: break
            }
        }
        if let summary = cuScrolledOutSummary(above: above, below: below), let target = inner.summaryNode, target < tree.nodes.count {
            let existing = tree.nodes[target].detail
            tree.nodes[target].detail = existing.map { "\($0); \(summary)" } ?? summary
        }
        return .visible
    }

    /// Children to walk, and how many of a long list were skipped above and below the
    /// visible part. Long lists use their visible rows, or a binary search over frames.
    private func childList(_ element: AXUIElement, role: String, attributes: [String: AnyObject], visible: CGRect?) -> ([AXUIElement], Int, Int) {
        if role == "AXMenuBar" { return ([], 0, 0) }
        let all = attributes["AXChildren"] as? [AXUIElement] ?? []
        guard all.count > 200 else { return (all, 0, 0) }
        for name in ["AXVisibleRows", "AXVisibleChildren"] {
            guard let rows = cuAttribute(element, name) as? [AXUIElement], !rows.isEmpty, rows.count <= 400 else { continue }
            let first = all.firstIndex { CFEqual($0, rows[0]) } ?? 0
            return (rows, first, max(0, all.count - first - rows.count))
        }
        if let visible, let range = cuVisibleRange(count: all.count, visible: visible, limit: 400, frameAt: { cuFrame(of: all[$0]) }) {
            return (Array(all[range]), range.lowerBound, all.count - range.upperBound)
        }
        tree.truncated = true
        return (Array(all.prefix(400)), 0, all.count - 400)
    }

    /// A value as the model sees it: clipped with its true length, and for long documents the
    /// part on screen rather than the first page.
    private func valueText(_ element: AXUIElement, role: String, raw: String?) -> String? {
        guard let raw else { return nil }
        let long = role == "AXTextArea" || role == "AXStaticText" || role == "AXTextField"
        let limit = long ? 2_000 : 300
        guard raw.utf16.count > limit else { return cuClip(raw, limit) }
        if role == "AXTextArea", let shown = cuVisibleText(element), !shown.isEmpty {
            return cuClip(cuClipValue(shown, limit: limit), limit + 40).map { "(on screen, of \(raw.count) chars) \($0)" }
        }
        return cuClip(String(raw.prefix(limit)), limit).map { "\($0)…(\(raw.count) chars)" }
    }
}

/// The text a text view shows on screen, read by range so a long document is never copied whole.
func cuVisibleText(_ element: AXUIElement) -> String? {
    guard let rangeValue = cuAttribute(element, "AXVisibleCharacterRange"), CFGetTypeID(rangeValue) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    guard AXValueGetValue(rangeValue as! AXValue, .cfRange, &range), range.length > 0 else { return nil }
    range.length = min(range.length, 4_000)
    guard let parameter = AXValueCreate(.cfRange, &range) else { return nil }
    var text: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(element, "AXStringForRange" as CFString, parameter, &text) == .success else { return nil }
    return text as? String
}
