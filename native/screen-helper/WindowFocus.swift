import AppKit
import ApplicationServices
import ScreenCaptureKit

/// Keyboard events go to an application's focused window. Refuse a different one.
@MainActor func requireFocusedWindow(_ target: SCWindow, candidates: [SCWindow]) throws {
    _ = try focusedWindowElement(target, candidates: candidates)
}

/// The application's focused Accessibility window, proven to be `target`. Reachable even when the
/// window is on another Space, where the application's window list is empty.
@MainActor func focusedWindowElement(_ target: SCWindow, candidates: [SCWindow]) throws -> AXUIElement {
    guard let app = target.owningApplication else { throw HelperError("Missing target application") }
    let application = AXUIElementCreateApplication(app.processID)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &value) == .success,
          let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { throw HelperError("Target window is not focused") }
    // The Core Foundation type id is checked before this bridge.
    let focused = value as! AXUIElement
    var role: CFTypeRef?
    guard AXUIElementCopyAttributeValue(focused, kAXRoleAttribute as CFString, &role) == .success,
          let role = role as? String, role == (kAXWindowRole as String) else { throw HelperError("Focused element is not an Accessibility window") }
    var position: CFTypeRef?
    var size: CFTypeRef?
    let positionStatus = AXUIElementCopyAttributeValue(focused, kAXPositionAttribute as CFString, &position)
    let sizeStatus = AXUIElementCopyAttributeValue(focused, kAXSizeAttribute as CFString, &size)
    guard positionStatus == .success, sizeStatus == .success,
          let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { throw HelperError("Cannot verify focused window bounds (position: \(positionStatus.rawValue), size: \(sizeStatus.rawValue))") }
    var origin = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
          AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { throw HelperError("Cannot decode focused window bounds") }
    let bounds = CGRect(origin: origin, size: dimensions)
    let matches = candidates.filter { candidate in
        guard let frame = try? currentWindowBounds(candidate) else { return false }
        return abs(frame.minX - bounds.minX) < 1 && abs(frame.minY - bounds.minY) < 1 && abs(frame.width - bounds.width) < 1 && abs(frame.height - bounds.height) < 1
    }
    guard matches.count == 1, matches.first?.windowID == target.windowID else { throw HelperError("Captured window must be the application's focused window") }
    return focused
}

/// The first button in `window` whose accessibility description or title is `name`, searched
/// breadth first through a bounded part of the tree (Simulator's toolbar and side buttons).
func windowButton(_ window: AXUIElement, named name: String) -> AXUIElement? {
    var queue = [(window, 0)]
    var visited = 0
    // Each call is bounded; the whole search is too, well inside the helper's command deadline.
    let deadline = DispatchTime.now().uptimeNanoseconds + 3_000_000_000
    while !queue.isEmpty, visited < 256, DispatchTime.now().uptimeNanoseconds < deadline {
        let (element, depth) = queue.removeFirst()
        visited += 1
        if (axAttribute(element, kAXRoleAttribute) as? String) == (kAXButtonRole as String),
           [kAXDescriptionAttribute, kAXTitleAttribute].contains(where: { (axAttribute(element, $0) as? String) == name }) { return element }
        if depth < 4 { queue += axChildren(element, maximum: 64).map { ($0, depth + 1) } }
    }
    return nil
}

/// The windows among `candidates` stacked in front of `target`, front to back. Windows on another
/// Space keep their stacking order, so this holds when the captured window isn't on screen. When
/// the order can't be read, every other candidate counts as in front.
func windowsInFront(of target: SCWindow, among candidates: [SCWindow]) -> [SCWindow] {
    let others = candidates.filter { $0.windowID != target.windowID }
    guard let rows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return others }
    let order = rows.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value }
    guard let position = order.firstIndex(of: target.windowID) else { return others }
    let front = Set(order.prefix(position))
    return others.filter { front.contains($0.windowID) }
}

/// Query one current window, verifying its owner before using its geometry.
func currentWindowBounds(_ window: SCWindow) throws -> CGRect {
    guard let app = window.owningApplication,
          let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], window.windowID) as? [[String: Any]],
          let row = rows.first,
          (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processID,
          let values = row[kCGWindowBounds as String] as? [String: Double],
          let x = values["X"], let y = values["Y"], let w = values["Width"], let h = values["Height"],
          x.isFinite, y.isFinite, w.isFinite, h.isFinite, w > 0, h > 0 else { throw HelperError("Target window is gone", code: "target_gone") }
    return CGRect(x: x, y: y, width: w, height: h)
}

/// Read the target and onscreen windows above it, never the full desktop history.
/// Only windows in front can intercept a pointer; the included target verifies its live owner.
struct PointerGeometry {
    let bounds: CGRect
    let front: [CGRect]
}
func pointerGeometry(_ window: SCWindow) throws -> PointerGeometry {
    guard let app = window.owningApplication,
          let rows = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow, .optionIncludingWindow], window.windowID) as? [[String: Any]] else {
        throw HelperError("Cannot verify pointer target", code: "target_gone")
    }
    var front: [CGRect] = []
    for row in rows {
        guard let id = row[kCGWindowNumber as String] as? NSNumber else { continue }
        let owner = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
        guard let values = row[kCGWindowBounds as String] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: values as CFDictionary),
              bounds.width > 0, bounds.height > 0 else { continue }
        if id.uint32Value == window.windowID {
            guard owner == app.processID else { throw HelperError("Pointer target owner changed", code: "target_gone") }
            return PointerGeometry(bounds: bounds, front: front)
        }
        if owner == app.processID { front.append(bounds) }
    }
    throw HelperError("Pointer target disappeared", code: "target_gone")
}
