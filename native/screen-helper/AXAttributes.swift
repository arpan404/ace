import ApplicationServices
import AppKit

struct UIBounds: Codable, Equatable { let x: Double; let y: Double; let w: Double; let h: Double
    var rect: CGRect { CGRect(x: x, y: y, width: w, height: h) }
}
struct UINode: Codable {
    let ref: String; let role: String; let name: String
    var secondaryActions: [String] = []; var value: String?; let description: String?; let bounds: UIBounds
    let states: [String]; var actions: [String]; var children: [UINode]
}
struct UITree: Codable { let nodes: [UINode]; let truncated: Bool }
func axAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func axChildren(_ element: AXUIElement, maximum: Int, attribute: String = kAXChildrenAttribute) -> [AXUIElement] {
    var values: CFArray?
    // Request only the bounded prefix; never copy an application's entire child list.
    var count: CFIndex = 0
    guard AXUIElementGetAttributeValueCount(element, attribute as CFString, &count) == .success,
          AXUIElementCopyAttributeValues(element, attribute as CFString, 0, min(maximum, count), &values) == .success,
          let array = values as? [AXUIElement] else { return [] }
    return array
}
func axBounds(_ position: CFTypeRef?, _ size: CFTypeRef?) -> UIBounds {
    var point = CGPoint.zero; var dimensions = CGSize.zero
    if let position, CFGetTypeID(position) == AXValueGetTypeID() { _ = AXValueGetValue(position as! AXValue, .cgPoint, &point) }
    if let size, CFGetTypeID(size) == AXValueGetTypeID() { _ = AXValueGetValue(size as! AXValue, .cgSize, &dimensions) }
    return UIBounds(x: point.x.isFinite ? point.x : 0, y: point.y.isFinite ? point.y : 0, w: dimensions.width.isFinite ? max(0, dimensions.width) : 0, h: dimensions.height.isFinite ? max(0, dimensions.height) : 0)
}
func axBounds(_ element: AXUIElement) -> UIBounds { axBounds(axAttribute(element, kAXPositionAttribute), axAttribute(element, kAXSizeAttribute)) }
func axText(_ value: CFTypeRef?, cap: Int) -> String? {
    if let string = value as? String { return String(string.prefix(cap)) }
    if let number = value as? NSNumber { return String(number.stringValue.prefix(cap)) }
    return nil
}
func axActionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
    return (names as? [String] ?? []).prefix(32).map { $0 }
}
struct AXSnapshot { var node: UINode; let secure: Bool; var truncated: Bool }
func axMetadata(_ element: AXUIElement, ref: String) -> AXSnapshot {
    // Never request the unbounded AXValue of an editor/document in the batch.
    let names = [kAXRoleAttribute, kAXTitleAttribute, kAXSubroleAttribute, kAXDescriptionAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXFocusedAttribute, kAXSelectedAttribute, kAXEnabledAttribute, "AXExpanded", "AXVisible"]
    var copied: CFArray?
    _ = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, [], &copied)
    let values = copied as? [CFTypeRef] ?? []
    func value(_ index: Int) -> CFTypeRef? { index < values.count ? values[index] : nil }
    let role = axText(value(0), cap: 128) ?? "AXUnknown"
    var absence = AXError.failure
    if let subrole = value(2), CFGetTypeID(subrole) == AXValueGetTypeID() { _ = AXValueGetValue(subrole as! AXValue, .axError, &absence) }
    let secure = classifyTextMetadata(role: value(0) as? String, subrole: value(2) as? String,
        roleRead: value(0) as? String != nil, subroleRead: value(2) as? String != nil || absence == .attributeUnsupported || absence == .noValue) != .ordinary
    let bounds = axBounds(value(4), value(5))
    var states: [String] = []
    for (index, name) in [(6, "focused"), (7, "selected"), (9, "expanded")] { if (value(index) as? Bool) == true { states.append(name) } }
    if (value(8) as? Bool) == false { states.append("disabled") }
    if (value(10) as? Bool) == false || bounds.w == 0 || bounds.h == 0 { states.append("offscreen") }
    let numeric = ["AXCheckBox", "AXRadioButton", "AXSlider", "AXProgressIndicator"].contains(role) ? axAttribute(element, kAXValueAttribute) as? NSNumber : nil
    if ["AXCheckBox", "AXRadioButton"].contains(role), numeric?.intValue == 1 { states.append("checked") }
    let rawTitle = axText(value(1), cap: 128)
    let title = rawTitle?.isEmpty == false ? rawTitle ?? "" : axText(value(3), cap: 128) ?? ""
    let clipped = ((value(1) as? String)?.prefix(129).count ?? 0) > 128 || ((value(3) as? String)?.prefix(129).count ?? 0) > 128
    return AXSnapshot(node: UINode(ref: ref, role: role, name: title, value: secure ? nil : numeric?.stringValue, description: axText(value(3), cap: 128), bounds: bounds, states: states, actions: [], children: []), secure: secure, truncated: clipped)
}
func axSnapshot(_ element: AXUIElement, ref: String) -> AXSnapshot {
    var snapshot = axMetadata(element, ref: ref)
    guard !snapshot.secure, ["AXTextField", "AXTextArea", "AXComboBox", "AXStaticText"].contains(snapshot.node.role),
          let count = axAttribute(element, kAXNumberOfCharactersAttribute) as? NSNumber, count.intValue >= 0 else { return snapshot }
    var range = CFRange(location: 0, length: min(256, count.intValue))
    guard let parameter = AXValueCreate(.cfRange, &range) else { return snapshot }
    var text: CFTypeRef?
    if AXUIElementCopyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute as CFString, parameter, &text) == .success {
        snapshot.node.value = axText(text, cap: 256)
    }
    snapshot.truncated = snapshot.truncated || count.intValue > 256
    return snapshot
}
func axActions(_ element: AXUIElement, secure: Bool, native: [String]) -> [String] {
    var actions: [String] = []
    if !native.isEmpty { actions.append("performSecondaryAction") }
    if native.contains(kAXPressAction) { actions.append("press") }
    for (attribute, action) in [(kAXFocusedAttribute, "focus"), (kAXValueAttribute, "setValue"), (kAXSelectedTextAttribute, "selectText"), (kAXSelectedAttribute, "select"), ("AXExpanded", "expand")] {
        var writable = DarwinBoolean(false)
        if AXUIElementIsAttributeSettable(element, attribute as CFString, &writable) == .success, writable.boolValue, !(secure && ["setValue", "selectText"].contains(action)) { actions.append(action) }
    }
    if native.contains("AXScrollDownByPage") || native.contains("AXScrollUpByPage") { actions.append("scroll") }
    return actions
}

/// The focused window can remain accessible on another Space when AXWindows is empty.
func axWindows(_ application: AXUIElement) -> [AXUIElement] {
    var windows = axChildren(application, maximum: 128, attribute: kAXWindowsAttribute)
    for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
        if let value = axAttribute(application, attribute), CFGetTypeID(value) == AXUIElementGetTypeID(), !windows.contains(where: { CFEqual($0, value) }) { windows.append(value as! AXUIElement) }
    }
    return windows
}
