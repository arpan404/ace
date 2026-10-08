import AppKit
import ApplicationServices
import ScreenCaptureKit
import Darwin

struct WindowCandidate: Codable, Equatable {
    let windowId: UInt32
    let title: String
    let bounds: UIBounds
}
// Read-only identity query. Optional symbol: unsupported systems keep the conservative fallback.
private typealias AXWindowFunction = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
private let axWindowFunction: AXWindowFunction? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
    return unsafeBitCast(symbol, to: AXWindowFunction.self)
}()
func axWindowID(_ element: AXUIElement) -> CGWindowID? {
    var id: CGWindowID = 0
    guard let function = axWindowFunction, function(element, &id) == .success, id != 0 else { return nil }
    return id
}
func containingAXWindow(_ element: AXUIElement) -> AXUIElement? {
    if axAttribute(element, kAXRoleAttribute) as? String == kAXWindowRole { return element }
    guard let value = axAttribute(element, kAXWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func windowCandidates(pid: pid_t) -> [WindowCandidate] {
    // CG rows preserve stacking order even for windows on another Space.
    let rows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
    return rows.filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid }.prefix(128).compactMap { row in
        guard let id = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let bounds = row[kCGWindowBounds as String] as? [String: Double],
              let x = bounds["X"], let y = bounds["Y"], let w = bounds["Width"], let h = bounds["Height"] else { return nil }
        return WindowCandidate(windowId: id, title: String((row[kCGWindowName as String] as? String ?? "").prefix(256)), bounds: UIBounds(x: x, y: y, w: w, h: h))
    }
}
func matchingWindowIDs(title: String, bounds: CGRect, candidates: [WindowCandidate]) -> [UInt32] {
    candidates.filter {
        let frame = $0.bounds.rect
        return (title.isEmpty || $0.title.isEmpty || title == $0.title) && abs(frame.minX - bounds.minX) < 1 && abs(frame.minY - bounds.minY) < 1 && abs(frame.width - bounds.width) < 1 && abs(frame.height - bounds.height) < 1
    }.map(\.windowId)
}
@MainActor func targetApplication(_ target: Target) throws -> NSRunningApplication {
    guard let bundle = target.bundleId else { throw HelperError("Application identity required", code: "bounds") }
    let app: NSRunningApplication?
    if target.kind == "window" {
        guard let id = target.windowId,
              let row = (CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]])?.first,
              let owner = row[kCGWindowOwnerPID as String] as? NSNumber else { throw HelperError("Target window is gone", code: "target_gone") }
        app = NSRunningApplication(processIdentifier: owner.int32Value)
    } else { app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first }
    guard let app, !app.isTerminated, app.bundleIdentifier == bundle else { throw HelperError("Target application is gone", code: "target_gone") }
    return app
}
@MainActor final class WindowResolver {
    private var cache: [UInt32: (pid_t, AXUIElement)] = [:]
    private var fields: [UInt32: AXUIElement] = [:]
    func invalidate() { cache.removeAll(); fields.removeAll() }
    func cachedField(_ window: SCWindow) throws -> AXUIElement? {
        guard let field = fields[window.windowID], axAttribute(field, kAXFocusedAttribute) as? Bool == true else { fields.removeValue(forKey: window.windowID); return nil }
        try requireDestination(field, window: window)
        return field
    }
    func rememberField(_ field: AXUIElement, window: SCWindow) {
        if fields.count >= 128 { fields.removeAll() }
        fields[window.windowID] = field
    }
    func identity(_ element: AXUIElement, pid: pid_t) throws -> UInt32 {
        var actual: pid_t = 0
        guard AXUIElementGetPid(element, &actual) == .success, actual == pid,
              let window = containingAXWindow(element) else { throw HelperError("Destination has no verified window", code: "no_key_window") }
        if let id = axWindowID(window) { return id }
        let candidates = windowCandidates(pid: pid)
        let matches = matchingWindowIDs(title: axAttribute(window, kAXTitleAttribute) as? String ?? "", bounds: axBounds(window).rect, candidates: candidates)
        guard matches.count == 1, let id = matches.first else { throw HelperError("Window identity is ambiguous", code: "window_ambiguous", candidates: candidates) }
        return id
    }
    func resolve(id: UInt32, pid: pid_t) throws -> AXUIElement {
        // Live CG owner validation also protects cached AX refs against closed/reused IDs.
        guard let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]], let row = rows.first,
              (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid else { cache.removeValue(forKey: id); throw HelperError("Target window is gone", code: "target_gone") }
        if let (owner, element) = cache[id], owner == pid, axAttribute(element, kAXRoleAttribute) as? String == kAXWindowRole, axWindowID(element) == id { return element }
        if cache.count >= 128 { cache.removeAll() }
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.05)
        let windows = axWindows(application)
        let exact = windows.filter { axWindowID($0) == id }
        if exact.count == 1, let element = exact.first { cache[id] = (pid, element); return element }
        let candidates = windowCandidates(pid: pid)
        let matches = windows.filter { window in
            // A known different ID must never participate in heuristic matching.
            if axWindowID(window) != nil { return false }
            return matchingWindowIDs(title: axAttribute(window, kAXTitleAttribute) as? String ?? "", bounds: axBounds(window).rect, candidates: candidates) == [id]
        }
        guard matches.count == 1, let element = matches.first else { throw HelperError("Cannot resolve the selected Accessibility window", code: windows.isEmpty ? "target_gone" : "window_ambiguous", candidates: candidates) }
        cache[id] = (pid, element); return element
    }
    func resolve(_ window: SCWindow) throws -> AXUIElement {
        guard let pid = window.owningApplication?.processID else { throw HelperError("Window owner is gone", code: "target_gone") }
        return try resolve(id: window.windowID, pid: pid)
    }
    func requireDestination(_ element: AXUIElement, window: SCWindow) throws {
        guard let pid = window.owningApplication?.processID, try identity(element, pid: pid) == window.windowID else { throw HelperError("Keyboard destination left the selected window", code: "no_key_window") }
    }
}
