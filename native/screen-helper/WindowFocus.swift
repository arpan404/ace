import AppKit
import ApplicationServices
import ScreenCaptureKit

/// Query the keyboard destination directly. Workspace notifications may lag a native
/// activation in a helper without an AppKit window/event loop.
@MainActor func keyboardApplicationPID() -> pid_t? {
    guard let value = axAttribute(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute),
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    var pid: pid_t = 0
    guard AXUIElementGetPid(value as! AXUIElement, &pid) == .success else { return nil }
    return pid
}

/// Keyboard events go to an application's focused window. Refuse a different one.
@MainActor func requireFocusedWindow(_ target: SCWindow, candidates: [SCWindow]) throws {
    _ = try focusedWindowElement(target, candidates: candidates)
}

/// The application's focused Accessibility window, proven to be `target`. Reachable even when the
/// window is on another Space, where the application's window list is empty.
@MainActor func appFocusedWindow(_ pid: pid_t) throws -> (AXUIElement, CGRect) {
    let application = AXUIElementCreateApplication(pid)
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
    return (focused, bounds)
}

/// One AX lookup and one live bounds lookup per candidate, including ambiguity checks.
@MainActor func focusedWindowMatch(_ candidates: [SCWindow]) throws -> (SCWindow, AXUIElement) {
    guard candidates.count <= 128, let app = candidates.first?.owningApplication,
          candidates.allSatisfy({ $0.owningApplication?.processID == app.processID }) else { throw HelperError("Ambiguous application windows", code: "window_ambiguous") }
    let (focused, _) = try appFocusedWindow(app.processID)
    let resolver = WindowResolver()
    let id = try resolver.identity(focused, pid: app.processID)
    guard let window = candidates.first(where: { $0.windowID == id }) else { throw HelperError("Focused window is unavailable", code: "no_key_window") }
    return (window, focused)
}
@MainActor func focusedWindowElement(_ target: SCWindow, candidates: [SCWindow]) throws -> AXUIElement {
    let (window, focused) = try focusedWindowMatch(candidates)
    guard window.windowID == target.windowID else { throw HelperError("Captured window must be the application's focused window") }
    return focused
}
@MainActor func appInputWindow(_ candidates: [SCWindow]) throws -> SCWindow { try focusedWindowMatch(candidates).0 }

/// The first button in `window` whose accessibility description or title is `name`, searched
/// breadth first through a bounded part of the tree (Simulator's toolbar and side buttons).
func windowButton(_ window: AXUIElement, named name: String, clock: () -> UInt64) -> AXUIElement? {
    var queue = [(window, 0)]
    var visited = 0
    // Each call is bounded; the whole search is too, well inside the helper's command deadline.
    let deadline = clock() + 3_000_000_000
    while !queue.isEmpty, visited < 256, clock() < deadline {
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

/// Include other Spaces. Only same-process windows above the verified target intercept input.
struct PointerGeometry {
    let bounds: CGRect
    let front: [CGRect]
}
func pointerGeometry(_ window: SCWindow) throws -> PointerGeometry {
    guard let app = window.owningApplication,
          let rows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
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

/// Capture and background input work off-display; minimized capture remains explicit.
@MainActor func validateCaptureWindow(_ window: SCWindow, displays: [SCDisplay]) throws {
    guard AXIsProcessTrusted() else { return }
    let element = try WindowResolver().resolve(window)
    if axAttribute(element, kAXMinimizedAttribute) as? Bool == true { throw HelperError("Target window is minimized", code: "window_minimized") }
}
@MainActor func requireForegroundPointerDisplay(_ window: SCWindow) throws {
    let bounds = try currentWindowBounds(window)
    guard NSScreen.screens.contains(where: { screen in
        let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
        return CGDisplayBounds(id).intersects(bounds)
    }) else { throw HelperError("Foreground pointer input is unavailable for an off-display target; use background semantic input", code: "window_offscreen") }
}

/// ScreenCaptureKit may omit minimized windows. Consult AX without activating the app.
@MainActor func unavailableWindow(_ target: Target) -> HelperError {
    guard let bundle = target.bundleId,
          let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first else { return HelperError("Target window unavailable", code: "target_gone") }
    if let id = target.windowId, let window = try? WindowResolver().resolve(id: id, pid: app.processIdentifier),
       axAttribute(window, kAXMinimizedAttribute) as? Bool == true { return HelperError("Target window is minimized", code: "window_minimized") }
    return HelperError("Target window unavailable", code: "target_gone")
}
