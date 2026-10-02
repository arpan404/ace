import ApplicationServices
import AppKit

struct UIBounds: Codable { let x: Double; let y: Double; let w: Double; let h: Double
    var rect: CGRect { CGRect(x: x, y: y, width: w, height: h) }
}
struct UINode: Codable {
    let ref: String; let role: String; let name: String
    let value: String?; let description: String?; let bounds: UIBounds
    let states: [String]; let actions: [String]; var children: [UINode]
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
func axNode(_ element: AXUIElement, ref: String) -> UINode {
    let names = [kAXRoleAttribute, kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXFocusedAttribute, kAXSelectedAttribute, kAXEnabledAttribute, "AXExpanded", "AXVisible"]
    var copied: CFArray?
    _ = AXUIElementCopyMultipleAttributeValues(element, names as CFArray, [], &copied)
    let values = copied as? [CFTypeRef] ?? []
    func value(_ index: Int) -> CFTypeRef? { index < values.count ? values[index] : nil }
    let role = axText(value(0), cap: 128) ?? "AXUnknown"
    let secure = role == "AXSecureTextField" || (axAttribute(element, kAXSubroleAttribute) as? String) == "AXSecureTextField"
    let bounds = axBounds(value(4), value(5))
    var states: [String] = []
    for (index, name) in [(6, "focused"), (7, "selected"), (9, "expanded")] { if (value(index) as? Bool) == true { states.append(name) } }
    if (value(8) as? Bool) == false { states.append("disabled") }
    if (value(10) as? Bool) == false || bounds.w == 0 || bounds.h == 0 { states.append("offscreen") }
    if ["AXCheckBox", "AXRadioButton"].contains(role), (value(2) as? NSNumber)?.intValue == 1 { states.append("checked") }
    let native = axActionNames(element)
    var actions: [String] = []
    if native.contains(kAXPressAction) { actions.append("press") }
    for (attribute, action) in [(kAXFocusedAttribute, "focus"), (kAXValueAttribute, "setValue"), (kAXSelectedAttribute, "select"), ("AXExpanded", "expand")] {
        var writable = DarwinBoolean(false)
        if AXUIElementIsAttributeSettable(element, attribute as CFString, &writable) == .success, writable.boolValue, !(secure && action == "setValue") { actions.append(action) }
    }
    if native.contains("AXScrollDownByPage") || native.contains("AXScrollUpByPage") { actions.append("scroll") }
    return UINode(ref: ref, role: role, name: axText(value(1), cap: 128) ?? axText(value(3), cap: 128) ?? "", value: secure ? nil : axText(value(2), cap: 256), description: axText(value(3), cap: 128), bounds: bounds, states: states, actions: actions, children: [])
}
