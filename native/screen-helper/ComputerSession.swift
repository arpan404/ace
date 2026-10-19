import AppKit
import ApplicationServices

/// What the helper remembers about one app between calls: element ids, the chosen window,
/// stable window numbers, the last walk and the last screenshot's geometry.
@MainActor final class CUAppSession {
    let app: NSRunningApplication
    let pid: pid_t
    let element: AXUIElement
    let registry = CUElementRegistry()
    let settler: CUSettler
    let windows: CUWindowLister
    /// The chosen window. Choosing another window forgets the screenshot geometry.
    var window: CUWindow? {
        didSet { if let shot, shot.window != window?.number { self.shot = nil } }
    }
    private(set) var lastNodes: [CUNode] = []
    private var nodeIndex: [Int: Int] = [:]
    /// The latest screenshot of the chosen window; pixel coordinates refer to it.
    private(set) var shot: CUShotGeometry?
    /// The app stopped answering during the last listing or walk.
    private(set) var notResponding = false
    let chromium: Bool
    /// Chromium trees appear a moment after first being asked for; wait once, the first time.
    var chromiumWarmed = false
    private var setManualAccessibility = false
    private var menuBar: (titles: [String], at: UInt64)?
    private var madeKey: CGWindowID?
    private(set) var lastUsed = cuNow()

    init(app: NSRunningApplication) {
        self.app = app
        pid = app.processIdentifier
        element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, cuAXTimeout)
        settler = CUSettler(pid: pid, application: element)
        windows = CUWindowLister(pid: pid, application: element)
        chromium = cuIsChromiumFamily(bundleId: app.bundleIdentifier, frameworks: cuBundleFrameworks(app.bundleURL))
        // Chromium and Electron build their accessibility tree only for clients that ask.
        // Never set AXEnhancedUserInterface: it is VoiceOver's flag and breaks window animations.
        if chromium, (cuAttribute(element, "AXManualAccessibility") as? Bool) != true {
            setManualAccessibility = AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
        }
    }

    var name: String { app.localizedName ?? app.bundleIdentifier ?? "app" }

    /// Called at the start of every request on this app.
    func beginRequest() {
        lastUsed = cuNow()
        madeKey = nil
    }

    /// Undoes what the helper changed in the app. Called when the session is dropped and at exit.
    func close() {
        settler.close()
        if setManualAccessibility, !app.isTerminated {
            AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanFalse)
        }
        setManualAccessibility = false
    }

    /// Makes the window that should receive keys the app's key window without bringing the
    /// app forward: a dialog, sheet or panel over the chosen window, else the chosen window.
    /// A frontmost app already routes keys itself, so it is left alone.
    func makeKey() {
        guard !app.isActive, let chosen = window?.number else { return }
        let target = cuKeyTarget(application: element, chosen: chosen)
        if madeKey == target.window, target.focused == target.window { return }
        if cuFocusWithoutActivating(pid: pid, window: target.window) {
            madeKey = target.window
            usleep(30_000)
        }
    }

    /// Keep the chosen window while it exists; otherwise the focused, main, or a visible window.
    /// A window number is the stable `index` shown in observations.
    func chooseWindow(_ selector: Any?, deadline: UInt64 = cuNow() + 1_500_000_000) throws -> [CUWindow] {
        let number = (selector as? NSNumber)?.intValue
        let title = (selector as? String).flatMap { $0.isEmpty ? nil : $0 }
        var listed = windows.list(remote: .none, deadline: deadline)
        let missing = (number.map { wanted in !listed.windows.contains { $0.index == wanted } } ?? false)
            || (title.map { wanted in !listed.windows.contains { $0.title.localizedCaseInsensitiveContains(wanted) } } ?? false)
        // Finder's desktop has no window-server id: an app showing only that has no window here.
        if !listed.notResponding, missing || !listed.windows.contains(where: { $0.number != nil }) {
            listed = windows.list(remote: missing ? .requested : .automatic, deadline: deadline)
        }
        notResponding = listed.notResponding
        let all = listed.windows
        let numbers = all.map { String($0.index) }.joined(separator: ", ")
        if let number {
            guard let match = all.first(where: { $0.index == number }) else {
                throw CUError("window_not_found", all.isEmpty ? "\(name) has no open window." : "\(name) has no window \(number); its windows are \(numbers).")
            }
            window = match
            return all
        }
        if let title {
            guard let match = all.first(where: { $0.title.localizedCaseInsensitiveContains(title) }) else {
                throw CUError("window_not_found", "No \(name) window title contains \"\(title)\". Windows: \(all.map { "\($0.index) \"\($0.title)\"" }.joined(separator: ", ")).")
            }
            window = match
            return all
        }
        if let current = window, let same = all.first(where: { CFEqual($0.element, current.element) }) { window = same; return all }
        let focused = cuElementAttribute(element, "AXFocusedWindow")
        window = all.first(where: { focused != nil && CFEqual($0.element, focused!) })
            ?? all.first(where: { $0.main && ($0.onScreen || $0.otherSpace) })
            ?? all.first(where: { $0.onScreen })
            ?? all.first(where: { $0.otherSpace })
            ?? all.first(where: { $0.minimized })
            // No window-server id (Finder's desktop): visibility unknown, but never ordered out.
            ?? all.first(where: { $0.number == nil })
            // A hidden app's windows are all off screen; never otherwise fall back to one.
            ?? (app.isHidden ? all.first : nil)
        return all
    }

    /// Walks the chosen window and any open menus, updating ids and the node index.
    @discardableResult
    func walk(deadline: UInt64) -> CUTree {
        registry.beginWalk()
        let walker = CUTreeWalker(registry: registry, deadline: deadline, focused: cuElementAttribute(element, "AXFocusedUIElement"))
        if let window {
            var context = CUWalkContext()
            if !window.minimized { context.visible = window.frame }
            walker.walk(window.element, depth: 0, context: context)
        }
        if !walker.tree.notResponding { for menu in cuOpenMenus(element) { walker.walk(menu, depth: 0) } }
        registry.prune()
        lastNodes = walker.tree.nodes
        nodeIndex = Dictionary(lastNodes.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        if walker.tree.notResponding { notResponding = true }
        return walker.tree
    }

    /// A fresh bounded walk of the current window, for `wait_for` and `when` conditions.
    func refreshNodes() -> [CUNode] {
        if let current = window, let frame = cuFrame(of: current.element) {
            window = CUWindow(element: current.element, number: current.number, title: current.title, frame: frame, onScreen: current.onScreen,
                              minimized: current.minimized, main: current.main, index: current.index, subrole: current.subrole, otherSpace: current.otherSpace)
        }
        return walk(deadline: cuNow() + 1_500_000_000).nodes
    }

    /// The outline node for an element, nil if the last walk did not include it.
    func node(for element: AXUIElement) -> CUNode? {
        guard let id = registry.existingId(for: element), let index = nodeIndex[id], index < lastNodes.count else { return nil }
        return lastNodes[index]
    }

    /// The topmost element of this app at a global screen point (true z-order).
    func element(atScreen point: CGPoint) -> AXUIElement? {
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(element, Float(point.x), Float(point.y), &hit) == .success else { return nil }
        return hit
    }

    /// Remembers the screenshot just taken of the chosen window.
    func recordScreenshot(scale: Double) {
        guard let window, let number = window.number else { return }
        shot = CUShotGeometry(window: number, size: window.frame.size, scale: scale)
    }

    /// Maps screenshot pixels to global screen points using the latest screenshot of the
    /// current window, against the window's current frame.
    func screenPoint(fromPixel pixel: CGPoint) throws -> CGPoint {
        guard let current = window else { throw CUError("no_window", "\(name) has no open window to click in.") }
        let frame = cuFrame(of: current.element) ?? current.frame
        return try cuMapPixel(pixel, shot: shot, window: current.number, frame: frame)
    }

    /// Converts screenshot pixels to a global screen point inside the chosen window.
    func globalPoint(x: Double, y: Double) throws -> CGPoint { try screenPoint(fromPixel: CGPoint(x: x, y: y)) }

    /// The smallest element from the last observation under a point, preferring ones that act.
    /// Ignores z-order; prefer `element(atScreen:)`.
    func hitTest(_ point: CGPoint) -> CUNode? {
        let containing = lastNodes.filter { $0.frame?.contains(point) == true }
        func area(_ node: CUNode) -> CGFloat { (node.frame?.width ?? 0) * (node.frame?.height ?? 0) }
        let acting = containing.filter { $0.axActions.contains("AXPress") || cuTextInputRoles.contains($0.axRole) || ["AXRow", "AXCell", "AXOutlineRow", "AXLink"].contains($0.axRole) }
        return (acting.isEmpty ? containing : acting).min { area($0) < area($1) }
    }

    /// Top-level menu titles, re-read at most every few seconds.
    func menuBarTitles() -> [String] {
        let now = cuNow()
        if let menuBar, now - menuBar.at < 5_000_000_000 { return menuBar.titles }
        let titles = cuMenuBarTitles(element)
        menuBar = (titles, now)
        return titles
    }

    func forgetMenuBar() { menuBar = nil }
}
