import AppKit
import ApplicationServices
import ScreenCaptureKit

/// Prefer an advertised action at a point, within the verified process and selected window.
/// Hit testing does not move the system cursor. Missing AX support leaves process events to Input.
@MainActor func performTargetedAXAction(_ window: SCWindow, at point: CGPoint, names: [String], beforeDispatch: (() -> Void)? = nil) throws -> Bool {
    guard let pid = window.owningApplication?.processID else { return false }
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), Float(point.x), Float(point.y), &hit) == .success, let hit else { return false }
    var actualPid: pid_t = 0
    guard AXUIElementGetPid(hit, &actualPid) == .success, actualPid == pid else { return false }
    _ = try currentWindowBounds(window)
    let containing: AXUIElement
    if (axAttribute(hit, kAXRoleAttribute) as? String) == kAXWindowRole { containing = hit }
    else {
        guard let value = axAttribute(hit, kAXWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return false }
        containing = value as! AXUIElement
    }
    guard try WindowResolver().identity(containing, pid: pid) == window.windowID else { return false }
    var element = hit
    for _ in 0..<8 {
        let actions = axActionNames(element)
        if axBounds(element).rect.contains(point), let name = names.first(where: { actions.contains($0) }) {
            beforeDispatch?()
            let result = AXUIElementPerformAction(element, name as CFString)
            if result == .success { return true }
            guard result == .actionUnsupported || result == .notImplemented else { throw HelperError("Target accessibility action failed", code: result == .invalidUIElement ? "target_gone" : "internal") }
            return false
        }
        if CFEqual(element, containing) { break }
        guard let parent = axAttribute(element, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
        element = parent as! AXUIElement
    }
    return false
}
