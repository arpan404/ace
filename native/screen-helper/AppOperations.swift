import AppKit
import ApplicationServices

@MainActor func openBackgroundURL(_ request: Request) async throws -> [String: Any] {
    guard let bundle = request.bundleId ?? request.target?.bundleId, request.allowlist?.contains(bundle) == true,
          let applicationURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { throw HelperError("Approved installed application required", code: "permission_denied") }
    guard let raw = request.url, raw.utf8.count <= 8192, !raw.contains("\0"), let url = URL(string: raw), url.scheme != nil else { throw HelperError("Absolute URL required", code: "bounds") }
    let guardState = FocusGuard()
    defer { _ = guardState.warning(targetPID: NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first?.processIdentifier) }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false; configuration.promptsUserIfNeeded = false; configuration.addsToRecentItems = false
    let app: NSRunningApplication
    do { app = try await NSWorkspace.shared.open([url], withApplicationAt: applicationURL, configuration: configuration) }
    catch { throw HelperError("Application could not acknowledge URL opening", code: "delivery_unconfirmed", phase: "dispatched") }
    guard app.bundleIdentifier == bundle else { throw HelperError("URL destination identity differs", code: "target_gone", phase: "dispatched") }
    var data: [String: Any] = ["bundleId": bundle, "pid": app.processIdentifier, "mode": "background", "phase": "dispatched", "delivery": "acknowledged"]
    if let warning = guardState.warning(targetPID: app.processIdentifier) { data["warnings"] = [warning] }
    return data
}

@MainActor func pressMenu(_ request: Request, beforeDispatch: () -> Void) throws {
    try requireMenuConsent(mode: request.mode, action: "menu.press")
    guard AXIsProcessTrusted() else { throw HelperError("Accessibility permission denied", code: "permission_denied") }
    guard CGPreflightScreenCaptureAccess() else { throw HelperError("Screen Recording permission denied", code: "permission_denied") }
    guard let target = request.target, let bundle = target.bundleId, request.allowlist?.contains(bundle) == true else { throw HelperError("Application approval required", code: "permission_denied") }
    let app = try targetApplication(target)
    guard let path = request.path, (1...8).contains(path.count), path.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 }) else { throw HelperError("Menu path must contain one to eight titles", code: "bounds") }
    let application = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(application, 0.05)
    guard let value = axAttribute(application, kAXMenuBarAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { throw HelperError("Application has no accessible menu bar", code: "not_supported") }
    var parent = value as! AXUIElement
    for (index, title) in path.enumerated() {
        var children = axChildren(parent, maximum: 65)
        // A menu-bar item wraps its submenu in one AXMenu child.
        if children.count == 1, let menu = children.first, axAttribute(menu, kAXRoleAttribute) as? String == kAXMenuRole { children = axChildren(menu, maximum: 65) }
        guard children.count <= 64 else { throw HelperError("Menu exceeds traversal budget", code: "busy") }
        let matches = children.filter { axAttribute($0, kAXTitleAttribute) as? String == title }
        guard matches.count == 1, let item = matches.first else { throw HelperError("Menu path is absent or ambiguous at \(title)", code: "not_supported") }
        if index == path.count - 1 {
            guard axAttribute(item, kAXEnabledAttribute) as? Bool != false, axActionNames(item).contains(kAXPressAction) else { throw HelperError("Menu item is not pressable", code: "not_supported") }
            beforeDispatch()
            guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else { throw HelperError("Menu item delivery was not acknowledged", code: "delivery_unconfirmed", phase: "dispatched") }
        } else { parent = item }
    }
}
