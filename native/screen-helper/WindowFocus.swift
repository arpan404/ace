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
    var position: CFTypeRef?
    var size: CFTypeRef?
    guard AXUIElementCopyAttributeValue(focused, kAXPositionAttribute as CFString, &position) == .success,
          AXUIElementCopyAttributeValue(focused, kAXSizeAttribute as CFString, &size) == .success,
          let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { throw HelperError("Cannot verify focused window bounds") }
    var origin = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &origin),
          AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { throw HelperError("Cannot decode focused window bounds") }
    let bounds = CGRect(origin: origin, size: dimensions)
    let matches = candidates.filter { abs($0.frame.minX - bounds.minX) < 1 && abs($0.frame.minY - bounds.minY) < 1 && abs($0.frame.width - bounds.width) < 1 && abs($0.frame.height - bounds.height) < 1 }
    guard matches.count == 1, matches.first?.windowID == target.windowID else { throw HelperError("Captured window must be the application's focused window") }
}
