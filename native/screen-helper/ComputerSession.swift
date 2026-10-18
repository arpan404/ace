import AppKit
import ApplicationServices

/// What the helper remembers about one app between calls: element ids, the chosen window,
/// the last walk's geometry for coordinate clicks and the last screenshot's scale.
@MainActor final class CUAppSession {
    let app: NSRunningApplication
    let pid: pid_t
    let element: AXUIElement
    let registry = CUElementRegistry()
    let settler: CUSettler
    var window: CUWindow?
    var lastNodes: [CUNode] = []
    var screenshotScale: Double?

    init(app: NSRunningApplication) {
        self.app = app
        pid = app.processIdentifier
        element = AXUIElementCreateApplication(pid)
        settler = CUSettler(pid: pid)
        AXUIElementSetMessagingTimeout(element, 1.5)
        // Chromium and Electron build their accessibility tree only for clients that ask.
        AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }

    var name: String { app.localizedName ?? app.bundleIdentifier ?? "app" }

    /// Makes the chosen window the app's key window without bringing the app forward.
    /// A frontmost app already routes keys itself, so it is left alone.
    func makeKey() {
        guard !app.isActive, let number = window?.number else { return }
        if cuFocusWithoutActivating(pid: pid, window: number) { usleep(30_000) }
    }

    /// Keep the chosen window while it exists; otherwise the main, focused or first window.
    func chooseWindow(_ selector: Any?) throws -> [CUWindow] {
        let windows = cuWindows(pid: pid)
        if let index = (selector as? NSNumber)?.intValue {
            guard index >= 1, index <= windows.count else { throw CUError("window_not_found", "\(name) has \(windows.count) window(s); pass window 1–\(windows.count).") }
            window = windows[index - 1]
            return windows
        }
        if let title = selector as? String, !title.isEmpty {
            guard let match = windows.first(where: { $0.title.localizedCaseInsensitiveContains(title) }) else {
                throw CUError("window_not_found", "No \(name) window title contains \"\(title)\". Windows: \(windows.map { "\"\($0.title)\"" }.joined(separator: ", ")).")
            }
            window = match
            return windows
        }
        if let current = window, let same = windows.first(where: { CFEqual($0.element, current.element) }) { window = same; return windows }
        let focused = cuAttribute(element, "AXFocusedWindow").map { $0 as! AXUIElement }
        window = windows.first(where: { focused != nil && CFEqual($0.element, focused!) })
            ?? windows.first(where: { $0.main })
            ?? windows.first(where: { !$0.minimized })
            ?? windows.first
        return windows
    }

    /// Walks the chosen window, any open menus, and reports focus and the menu bar.
    func observe(windows: [CUWindow]) -> CUObject {
        registry.beginWalk()
        let walker = CUTreeWalker(registry: registry)
        if let window { walker.walk(window.element, depth: 0) }
        for menu in cuOpenMenus(element) { walker.walk(menu, depth: 0) }
        registry.prune()
        lastNodes = walker.tree.nodes
        var result: CUObject = [
            "app": ["name": name, "bundleId": app.bundleIdentifier ?? "", "pid": Int(pid), "active": app.isActive, "hidden": app.isHidden],
            "windows": windows.enumerated().map { index, item -> CUObject in
                var entry: CUObject = ["index": index + 1, "title": item.title, "onScreen": item.onScreen]
                if item.minimized { entry["minimized"] = true }
                if let window, CFEqual(item.element, window.element) { entry["current"] = true }
                return entry
            },
            "nodes": walker.tree.nodes.map { $0.json(origin: window?.frame.origin ?? .zero) },
            "truncated": walker.tree.truncated,
            "menuBar": cuMenuBarTitles(element),
        ]
        if let window { result["window"] = ["title": window.title, "width": Int(window.frame.width), "height": Int(window.frame.height), "onScreen": window.onScreen] }
        if let focused = cuAttribute(element, "AXFocusedUIElement") {
            let focusedElement = focused as! AXUIElement
            var entry: CUObject = ["role": cuAttribute(focusedElement, "AXRoleDescription") as? String ?? cuRole(focusedElement)]
            if let id = registry.existingId(for: focusedElement) { entry["id"] = id }
            if let title = cuClip((cuAttribute(focusedElement, "AXTitle") as? String) ?? (cuAttribute(focusedElement, "AXDescription") as? String), 120) { entry["name"] = title }
            if let selected = cuClip(cuAttribute(focusedElement, "AXSelectedText") as? String, 500), cuRole(focusedElement) != "AXSecureTextField" { entry["selectedText"] = selected }
            result["focused"] = entry
        }
        return result
    }

    /// Converts screenshot pixels to a global screen point inside the chosen window.
    func globalPoint(x: Double, y: Double) throws -> CGPoint {
        guard let window else { throw CUError("no_window", "\(name) has no open window to click in.") }
        guard let scale = screenshotScale else {
            throw CUError("no_screenshot", "Coordinates refer to a screenshot. Observe with screenshot:true first, or click an element id instead.")
        }
        let point = CGPoint(x: window.frame.minX + x / scale, y: window.frame.minY + y / scale)
        guard window.frame.contains(point) else {
            throw CUError("outside_window", "(\(Int(x)), \(Int(y))) is outside the screenshot (\(Int(window.frame.width * scale))×\(Int(window.frame.height * scale))).")
        }
        return point
    }

    /// The smallest element from the last observation under a point, preferring ones that act.
    func hitTest(_ point: CGPoint) -> CUNode? {
        let containing = lastNodes.filter { $0.frame?.contains(point) == true }
        func area(_ node: CUNode) -> CGFloat { (node.frame?.width ?? 0) * (node.frame?.height ?? 0) }
        let acting = containing.filter { $0.axActions.contains("AXPress") || cuTextInputRoles.contains($0.axRole) || ["AXRow", "AXCell", "AXOutlineRow", "AXLink"].contains($0.axRole) }
        return (acting.isEmpty ? containing : acting).min { area($0) < area($1) }
    }
}
