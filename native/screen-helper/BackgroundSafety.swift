import AppKit
import ApplicationServices

struct FocusState: Equatable {
    let pid: pid_t?; let cursor: CGPoint
    var window: AXUIElement? = nil; var element: AXUIElement? = nil
    static func == (lhs: Self, rhs: Self) -> Bool {
        func equal(_ a: AXUIElement?, _ b: AXUIElement?) -> Bool {
            switch (a, b) { case (nil, nil): return true; case let (a?, b?): return CFEqual(a, b); default: return false }
        }
        return lhs.pid == rhs.pid && lhs.cursor == rhs.cursor && equal(lhs.window, rhs.window) && equal(lhs.element, rhs.element)
    }
}
struct FocusDecision {
    let restoreFocus: Bool; let restoreCursor = false; let restoreAXFocus: Bool
    var changed: Bool { restoreFocus || restoreAXFocus }
    init(before: FocusState, after: FocusState, targetPID: pid_t?, targetWindow: AXUIElement?) {
        restoreFocus = targetPID != nil && before.pid != targetPID && after.pid == targetPID
        restoreAXFocus = before.pid == targetPID && after.pid == targetPID && targetWindow != nil &&
            after.window.map { CFEqual($0, targetWindow) } == true && before.window.map { CFEqual($0, targetWindow) } != true
    }
}
@MainActor struct FocusRuntime {
    let read: () -> FocusState
    let uptime: () -> Double
    let humanInput: (Double) -> Bool
    static let live = FocusRuntime(read: {
        let pid = keyboardApplicationPID()
        func focused(_ attribute: String) -> AXUIElement? {
            guard let pid, let value = axAttribute(AXUIElementCreateApplication(pid), attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
            return (value as! AXUIElement)
        }
        return FocusState(pid: pid, cursor: .zero, window: focused(kAXFocusedWindowAttribute))
    }, uptime: { ProcessInfo.processInfo.systemUptime }, humanInput: { elapsed in
        [CGEventType.mouseMoved, .leftMouseDown, .rightMouseDown, .keyDown, .scrollWheel, .flagsChanged, .leftMouseDragged, .rightMouseDragged].contains {
            CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) <= elapsed
        }
    })
}
@MainActor struct FocusGuard {
    let before: FocusState; let started: Double; let runtime: FocusRuntime
    let targetPID: pid_t?; let targetWindow: AXUIElement?
    init(targetPID: pid_t? = nil, targetWindow: AXUIElement? = nil, runtime: FocusRuntime? = nil) {
        let runtime = runtime ?? .live
        self.runtime = runtime; self.targetPID = targetPID; self.targetWindow = targetWindow
        before = runtime.read(); started = runtime.uptime()
    }
    /// Success stays success. Human activity and unrelated focus changes are not ace violations.
    func warning(targetPID completedPID: pid_t? = nil) -> String? {
        let after = runtime.read()
        guard !runtime.humanInput(runtime.uptime() - started) else { return nil }
        let decision = FocusDecision(before: before, after: after, targetPID: completedPID ?? targetPID, targetWindow: targetWindow)
        guard decision.changed else { return nil }
        return "Background action changed target focus; delivery succeeded. Do not retry."
    }
}
@MainActor func openBackgroundApp(_ request: Request) async throws -> [String: Any] {
    guard let bundle = request.bundleId, request.allowlist?.contains(bundle) == true,
          let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { throw HelperError("Approved installed application required", code: "permission_denied") }
    if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first, !app.isTerminated {
        return ["bundleId": bundle, "pid": app.processIdentifier, "mode": "background"]
    }
    let guardState = FocusGuard()
    let app = try await backgroundLaunch(at: url, guardState: guardState, wait: {},
        open: { url, configuration in try await NSWorkspace.shared.openApplication(at: url, configuration: configuration) })
    guard app.bundleIdentifier == bundle else { throw HelperError("Launched app identity differs", code: "target_gone", phase: "dispatched") }
    var data: [String: Any] = ["bundleId": bundle, "pid": app.processIdentifier, "mode": "background"]
    if let warning = guardState.warning(targetPID: app.processIdentifier) { data["warnings"] = [warning] }
    return data
}
@MainActor func backgroundLaunch<T>(at url: URL, guardState: FocusGuard, wait: () async throws -> Void, open: (URL, NSWorkspace.OpenConfiguration) async throws -> T) async throws -> T {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false; configuration.hides = true
    let result = try await open(url, configuration)
    try await wait()
    return result
}
