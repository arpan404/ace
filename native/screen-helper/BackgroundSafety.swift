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
    let restoreFocus: Bool; let restoreCursor: Bool; let restoreAXFocus: Bool
    var changed: Bool { restoreFocus || restoreCursor || restoreAXFocus }
    init(before: FocusState, after: FocusState) {
        restoreFocus = before.pid != after.pid
        restoreCursor = before.cursor != after.cursor
        restoreAXFocus = FocusState(pid: before.pid, cursor: before.cursor, window: before.window, element: before.element) != FocusState(pid: before.pid, cursor: before.cursor, window: after.window, element: after.element)
    }
}
@MainActor struct FocusRuntime {
    let read: () -> FocusState
    let uptime: () -> Double
    let humanInput: (Double) -> Bool
    let restore: (FocusState, FocusDecision) -> Void
    static let live = FocusRuntime(read: {
        let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        func focused(_ attribute: String) -> AXUIElement? {
            guard let pid, let value = axAttribute(AXUIElementCreateApplication(pid), attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
            return (value as! AXUIElement)
        }
        return FocusState(pid: pid, cursor: CGEvent(source: nil)?.location ?? .zero, window: focused(kAXFocusedWindowAttribute), element: focused(kAXFocusedUIElementAttribute))
    }, uptime: { ProcessInfo.processInfo.systemUptime }, humanInput: { elapsed in
        [CGEventType.mouseMoved, .leftMouseDown, .rightMouseDown, .keyDown, .scrollWheel, .flagsChanged, .leftMouseDragged, .rightMouseDragged].contains {
            CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) <= elapsed
        }
    }, restore: { before, decision in
        if decision.restoreFocus, let pid = before.pid { _ = NSRunningApplication(processIdentifier: pid)?.activate(options: []) }
        if decision.restoreAXFocus {
            if let window = before.window { _ = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
            if let element = before.element { _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) }
        }
        if decision.restoreCursor { CGWarpMouseCursorPosition(before.cursor) }
    })
}
@MainActor struct FocusGuard {
    let before: FocusState; let started: Double; let runtime: FocusRuntime
    init() { self.init(runtime: .live) }
    init(runtime: FocusRuntime) { self.runtime = runtime; before = runtime.read(); started = runtime.uptime() }
    func verify() throws {
        let decision = FocusDecision(before: before, after: runtime.read())
        guard decision.changed else { return }
        if runtime.humanInput(runtime.uptime() - started) { throw HelperError("Focus changed during human input; the human's desktop was retained", code: "focus_changed") }
        runtime.restore(before, decision)
        throw HelperError("Background action changed focus or cursor; restoration attempted", code: "focus_changed")
    }
}

@MainActor func openBackgroundApp(_ request: Request) async throws -> [String: Any] {
    guard let bundle = request.bundleId, request.allowlist?.contains(bundle) == true,
          let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { throw HelperError("Approved installed application required", code: "permission_denied") }
    if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first, !app.isTerminated {
        return ["bundleId": bundle, "pid": app.processIdentifier, "mode": "background"]
    }
    let guardState = FocusGuard()
    let app = try await backgroundLaunch(at: url, guardState: guardState,
        wait: { try await Task.sleep(nanoseconds: 100_000_000) },
        open: { url, configuration in try await NSWorkspace.shared.openApplication(at: url, configuration: configuration) })
    guard app.bundleIdentifier == bundle else { throw HelperError("Launched app identity differs", code: "target_gone") }
    return ["bundleId": bundle, "pid": app.processIdentifier, "mode": "background"]
}


@MainActor func backgroundLaunch<T>(at url: URL, guardState: FocusGuard, wait: () async throws -> Void, open: (URL, NSWorkspace.OpenConfiguration) async throws -> T) async throws -> T {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.hides = true
    let result = try await open(url, configuration)
    try await wait()
    try guardState.verify()
    return result
}
