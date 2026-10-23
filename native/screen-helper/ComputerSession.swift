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
    private var lastTree: CUTree?
    private var lastStamp: CUWalkStamp?
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
    var innerActive = false
    private var lastSessionStatus: CUSessionStatus?
    var agentFocus: AXUIElement?
    private var agentFocusWindow: CGWindowID?
    var actionTarget: AXUIElement?
    var actionKind = ""
    var actionRevision = 0

    var agentInputFocus: AXUIElement? { agentFocusWindow == window?.number ? agentFocus : nil }

    /// Explicit element input can share a window without changing the person's caret.
    var preserveHumanFocus: Bool {
        guard app.isActive, !cuScreenLocked() else { return false }
        if sharingActiveApp { return true }
        guard let target = actionTarget ?? agentInputFocus else { return false }
        guard let focused = cuElementAttribute(element, "AXFocusedUIElement") else { return true }
        return !CFEqual(target, focused)
    }

    var conflictsWithHuman: Bool {
        let focused = cuElementAttribute(element, "AXFocusedUIElement")
        var containsFocus = false
        if let target = actionTarget {
            var current = focused
            for _ in 0..<8 {
                guard let element = current else { break }
                if CFEqual(element, target) { containsFocus = true; break }
                current = cuElementAttribute(element, "AXParent")
            }
        }
        let pointerAction = ["click", "move", "drag", "action"].contains(actionKind)
        let cursorOnTarget = pointerAction && actionTarget.flatMap(cuFrame(of:)).map { frame in
            CGEvent(source: nil).map { frame.contains($0.location) } ?? true
        } == true
        return cuConflictsWithHuman(CUHumanTargetFacts(observing: ["wait", "wait_for"].contains(actionKind),
            explicitTarget: actionTarget != nil, sameWindow: !sharingActiveApp, focusKnown: focused != nil,
            containsFocus: containsFocus, pointerAction: pointerAction, cursorOnTarget: cursorOnTarget))
    }

    func prepareAction(_ action: CUObject) {
        actionKind = action.string("type") ?? ""
        actionTarget = action.int("id").flatMap { registry.element($0) }
        actionRevision &+= 1
        if let target = actionTarget, ["type", "paste", "key", "focus", "select_text"].contains(actionKind) { rememberFocus(target) }
    }

    /// The person owns another window of this frontmost app. App-wide focus, first
    /// responder commands and tracking menus must remain with that window.
    var sharingActiveApp: Bool {
        guard app.isActive, !cuScreenLocked(), let chosen = window?.number else { return false }
        guard let focused = cuElementAttribute(element, "AXFocusedWindow"), let number = cuWindowNumber(focused) else { return true }
        return number != chosen
    }

    func rememberFocus(_ target: AXUIElement) {
        agentFocus = target
        agentFocusWindow = window?.number
    }
    private(set) var lastUsed = cuNow()

    init(app: NSRunningApplication) {
        self.app = app
        pid = app.processIdentifier
        element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, cuAXTimeout)
        settler = CUSettler(pid: pid, application: element)
        windows = CUWindowLister(pid: pid, application: element)
        chromium = cuIsChromiumFamily(bundleId: app.bundleIdentifier, frameworks: cuBundleFrameworks(app.bundleURL))
        settler.observed = { [registry] element, notification in
            let key = CUElementKey(element: element)
            if notification == "AXUIElementDestroyed" { registry.facts.destroyed(key) } else { registry.facts.changed(key) }
        }
        // Chromium and Electron build their accessibility tree only for clients that ask.
        // Never set AXEnhancedUserInterface: it is VoiceOver's flag and breaks window animations.
        if chromium, (cuAttribute(element, "AXManualAccessibility") as? Bool) != true {
            setManualAccessibility = AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
        }
    }

    var name: String { app.localizedName ?? app.bundleIdentifier ?? "app" }

    /// Called at the start of every request on this app.
    func beginRequest() {
        let status = cuSessionStatus()
        if lastSessionStatus != status {
            shot = nil
            lastStamp = nil
            agentFocus = nil
            madeKey = nil
        }
        lastSessionStatus = status
        if agentFocusWindow != window?.number { agentFocus = nil }
        lastUsed = cuNow()
        madeKey = nil
        notResponding = false
    }

    /// A previous step or the person can move, restore or minimize this window during a batch.
    func refreshWindow() {
        guard let current = window else { return }
        let (attributes, status) = cuFetchStatus(current.element, ["AXPosition", "AXSize", "AXMinimized"])
        guard status == .success, let frame = cuFrame(attributes) else { return }
        let minimized = attributes["AXMinimized"] as? Bool ?? current.minimized
        let onScreen = current.number.flatMap { cuServerWindowInfo([$0])[$0]?.onScreen } ?? false
        let otherSpace = !onScreen && !minimized && current.number.map(cuWindowIsOnSomeSpace) == true
        if current.onScreen != onScreen || current.minimized != minimized || current.otherSpace != otherSpace { madeKey = nil }
        window = CUWindow(element: current.element, number: current.number, title: current.title, frame: frame,
                          onScreen: onScreen, minimized: minimized, main: current.main, index: current.index,
                          subrole: current.subrole, otherSpace: otherSpace)
    }

    /// Undoes what the helper changed in the app. Called when the session is dropped and at exit.
    func endRequest() {
        deactivateInside()
        madeKey = nil
    }

    func close() {
        deactivateInside()
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
        guard cuSessionStatus() == .active else { return }
        guard let current = window, let chosen = current.number else { return }
        let route = cuKeyRoute(CUKeyRouteFacts(appFrontmost: app.isActive, hasWindowNumber: true, onScreen: current.onScreen,
                                               otherSpace: current.otherSpace, minimized: current.minimized))
        switch route {
        case .frontmost, .none: return
        case .focusRecords:
            let target = cuKeyTarget(application: element, chosen: chosen)
            if madeKey == target.window, target.focused == target.window { return }
            if cuFocusWithoutActivating(pid: pid, window: target.window) {
                madeKey = target.window
                usleep(30_000)
            }
        case .innerActivation:
            let target = cuKeyTarget(application: element, chosen: chosen)
            if madeKey == target.window, innerActive { return }
            _ = activateInside()
            // An active app's main window is its key window; a sheet on it takes the keys itself.
            let targetElement = target.window == chosen ? current.element : cuElementAttribute(element, "AXFocusedWindow")
            if let targetElement { AXUIElementSetAttributeValue(targetElement, "AXMain" as CFString, kCFBooleanTrue) }
            madeKey = target.window
            usleep(20_000)
        }
    }

    /// Keep the chosen window while it exists; otherwise the focused, main, or a visible window.
    /// A window number is the stable `index` shown in observations.
    func chooseWindow(_ selector: Any?, deadline: UInt64 = cuNow() + 1_500_000_000) throws -> [CUWindow] {
        guard cuSessionStatus() != .unavailable else { throw cuSessionUnavailableError }
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
        if all.isEmpty, cuSessionStatus() == .locked, selector != nil { throw cuLockedControlsError }
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
        lastTree = walker.tree
        lastStamp = walker.tree.notResponding || walker.tree.truncated ? nil : stamp(focused: walker.focusedElement)
        nodeIndex = Dictionary(lastNodes.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        if walker.tree.notResponding { notResponding = true }
        return walker.tree
    }

    private func stamp(focused: AXUIElement?) -> CUWalkStamp {
        CUWalkStamp(events: settler.events, at: cuNow(), window: window.map { CUElementKey(element: $0.element) }, frame: window?.frame,
                     focused: focused.map { CUElementKey(element: $0) })
    }

    /// The last walk when nothing can have changed since (see `cuWalkStillCurrent`), else a new one.
    func walkUnlessUnchanged(deadline: UInt64) async -> CUTree {
        // Let notifications already sent by the app arrive before trusting silence.
        try? await Task.sleep(nanoseconds: 1_000_000)
        let now = stamp(focused: cuElementAttribute(element, "AXFocusedUIElement"))
        if let lastTree, cuWalkStillCurrent(last: lastStamp, now: now, maxAgeNs: 2_000_000_000, observingEverything: settler.observingEverything) {
            return lastTree
        }
        return walk(deadline: deadline)
    }

    /// A fresh bounded walk of the current window, for `wait_for` and `when` conditions.
    func refreshNodes() -> [CUNode] {
        if let current = window, let frame = cuFrame(of: current.element) {
            window = CUWindow(element: current.element, number: current.number, title: current.title, frame: frame, onScreen: current.onScreen,
                              minimized: current.minimized, main: current.main, index: current.index, subrole: current.subrole, otherSpace: current.otherSpace)
        }
        // Conditions re-check after each settle; when the app sent nothing since the last
        // walk, that walk still describes the window.
        let now = stamp(focused: cuElementAttribute(element, "AXFocusedUIElement"))
        if cuWalkStillCurrent(last: lastStamp, now: now, maxAgeNs: 2_000_000_000, observingEverything: settler.observingEverything) { return lastNodes }
        return walk(deadline: cuNow() + 1_000_000_000).nodes
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
        guard !cuScreenLocked() else {
            throw CUError("screen_locked", "Screenshot coordinates are unavailable while the Mac is locked. Use an element id from the accessibility outline.")
        }
        guard let current = window else { throw CUError("no_window", "\(name) has no open window to click in.") }
        let frame = cuFrame(of: current.element) ?? current.frame
        return try cuMapPixel(pixel, shot: shot, window: current.number, frame: frame)
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
