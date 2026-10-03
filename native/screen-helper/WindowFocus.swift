import AppKit
import ApplicationServices
import ScreenCaptureKit

/// Keyboard events go to an application's focused window. Refuse a different one.
@MainActor func requireFocusedWindow(_ target: SCWindow, candidates: [SCWindow]) throws {
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
