import AppKit
import ApplicationServices
import IOKit.pwr_mgt

// The individual checks of the locked-Mac probe (ComputerLockedProbe.swift). Each returns
// whether the mechanism worked and what it observed.

@MainActor func cuProbeLockFacts() -> (Bool, CUObject) {
    let session = (CGSessionCopyCurrentDictionary() as? [String: Any]) ?? [:]
    var sessionFacts: CUObject = [:]
    for (key, value) in session where value is Bool || value is Int || value is String { sessionFacts[key] = value }
    var displayCount: UInt32 = 0
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    CGGetOnlineDisplayList(16, &ids, &displayCount)
    let displays: [CUObject] = ids.prefix(Int(displayCount)).map { id in
        ["id": Int(id), "asleep": CGDisplayIsAsleep(id) != 0, "active": CGDisplayIsActive(id) != 0, "main": CGDisplayIsMain(id) != 0]
    }
    let screenSaver = NSWorkspace.shared.runningApplications.contains {
        $0.bundleIdentifier == "com.apple.ScreenSaver.Engine" || $0.localizedName == "ScreenSaverEngine" || $0.localizedName == "legacyScreenSaver"
    }
    let front = NSWorkspace.shared.frontmostApplication
    let facts = CUGuardFacts(locked: cuScreenLocked(), appFrontmost: false, secondsSinceHumanInput: cuSecondsSinceHumanInput(), stopRequested: false)
    var guardView = "allowed"
    do { try cuGuard(facts, app: "TextEdit") } catch let fault as CUError { guardView = fault.code } catch { guardView = "\(error)" }
    return (true, [
        "screenIsLocked": cuScreenLocked(), "session": sessionFacts, "displays": displays, "screenSaverRunning": screenSaver,
        "frontmostApp": front?.bundleIdentifier ?? "none", "secondsSinceHumanInput": min(cuSecondsSinceHumanInput(), 1e9),
        "guardView": guardView, "accessibilityTrusted": AXIsProcessTrusted(), "screenRecordingGranted": CGPreflightScreenCaptureAccess(),
    ])
}

func cuProbePowerAssertion() -> (Bool, CUObject) {
    var assertion: IOPMAssertionID = 0
    let status = IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), "ace locked probe" as CFString, &assertion)
    if status == kIOReturnSuccess { IOPMAssertionRelease(assertion) }
    return (status == kIOReturnSuccess, ["status": Int(status)])
}

/// Writes a marker to the general pasteboard, reads it back, then puts the person's clipboard back.
@MainActor func cuProbeClipboard() -> (Bool, CUObject) {
    let board = NSPasteboard.general
    let saved = CUClipboard.snapshot(board, owner: getpid(), token: "probe")
    let marker = "ace-locked-probe-\(getpid())-\(cuNow())"
    board.clearContents()
    let wrote = board.setString(marker, forType: .string)
    let readBack = board.string(forType: .string)
    CUClipboard.restore(saved, to: board)
    return (wrote && readBack == marker, ["wrote": wrote, "readBackMatches": readBack == marker, "restoredItems": saved.items.count])
}

/// Every window of the app on any Space, found the way the engine finds them.
@MainActor func cuProbeWindows(_ app: NSRunningApplication) -> [CUWindow] {
    let lister = CUWindowLister(pid: app.processIdentifier, application: AXUIElementCreateApplication(app.processIdentifier))
    return lister.list(remote: .requested, deadline: cuNow() + 2_000_000_000).windows
}

@MainActor func cuProbeFirstWindow(_ app: NSRunningApplication) -> AXUIElement? {
    let windows = cuProbeWindows(app)
    return (windows.first { $0.main && !$0.minimized } ?? windows.first { !$0.minimized })?.element
}

/// The accessibility element of one window-server window: through the engine's lister, else
/// the app's focused or main window (a new window on another Space can have an element id
/// beyond the lister's search), else after making that window key without activating the app.
@MainActor func cuProbeReach(_ app: NSRunningApplication, _ number: CGWindowID) async -> (AXUIElement?, String) {
    if let listed = cuProbeWindows(app).first(where: { $0.number == number }) { return (listed.element, "lister") }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    func focusedOrMain() -> AXUIElement? {
        ["AXFocusedWindow", "AXMainWindow"].lazy.compactMap { cuElementAttribute(element, $0) }.first { cuWindowNumber($0) == number }
    }
    if let window = focusedOrMain() { return (window, "focused_or_main") }
    guard cuFocusWithoutActivating(pid: app.processIdentifier, window: number) else { return (nil, "unreachable") }
    try? await Task.sleep(nanoseconds: 150_000_000)
    if let window = focusedOrMain() { return (window, "made_key") }
    return (nil, "unreachable")
}

/// The app's normal-layer window-server windows, on this Space or another.
func cuProbeServerWindows(pid: pid_t) -> Set<CGWindowID> {
    let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var found = Set<CGWindowID>()
    for row in info where (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid && (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 {
        guard let number = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let bounds = row[kCGWindowBounds as String] as? [String: Any],
              ((bounds["Height"] as? NSNumber)?.doubleValue ?? 0) >= 60, ((bounds["Width"] as? NSNumber)?.doubleValue ?? 0) >= 60 else { continue }
        found.insert(number)
    }
    return found
}

/// Breadth-first over a subtree, at most `limit` elements.
func cuProbeDescendants(_ root: AXUIElement, limit: Int = 2_000) -> [AXUIElement] {
    var queue = [root], found: [AXUIElement] = [], index = 0
    while index < queue.count, found.count < limit {
        let element = queue[index]
        index += 1
        found.append(element)
        queue.append(contentsOf: (cuAttribute(element, "AXChildren") as? [AXUIElement]) ?? [])
    }
    return found
}

func cuProbeLabels(_ element: AXUIElement) -> [String] {
    ["AXTitle", "AXDescription", "AXIdentifier", "AXValue"].compactMap { cuAttribute(element, $0) as? String }.filter { !$0.isEmpty }
}

@MainActor func cuProbeTreeRead(_ app: NSRunningApplication, window: AXUIElement? = nil) -> (Bool, CUObject) {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    let windows = (cuAttribute(element, "AXWindows") as? [AXUIElement]) ?? []
    guard let target = window ?? cuProbeFirstWindow(app) else { return (false, ["windows": windows.count, "note": "no window"]) }
    let nodes = cuProbeDescendants(target)
    var roles: [String: Int] = [:]
    for node in nodes { roles[cuRole(node), default: 0] += 1 }
    return (nodes.count > 1, ["windows": windows.count, "elements": nodes.count, "roles": roles, "title": cuAttribute(target, "AXTitle") as? String ?? ""])
}

// MARK: Calculator

/// The first button labelled with the earliest name in `names` that any button carries.
func cuProbeCalculatorButton(_ window: AXUIElement, _ names: [String]) -> AXUIElement? {
    let buttons = cuProbeDescendants(window).filter { cuRole($0) == "AXButton" }
    for name in names {
        if let button = buttons.first(where: { cuProbeLabels($0).contains { $0.caseInsensitiveCompare(name) == .orderedSame } }) { return button }
    }
    return nil
}

func cuProbeCalculatorTexts(_ window: AXUIElement) -> [String] {
    cuProbeDescendants(window).filter { ["AXStaticText", "AXTextField", "AXScrollArea", "AXGroup"].contains(cuRole($0)) }
        .flatMap { [cuAttribute($0, "AXValue") as? String, cuAttribute($0, "AXDescription") as? String].compactMap { $0 } }
        .filter { !$0.isEmpty }.prefix(20).map { $0 }
}

let cuProbeClearNames = ["All Clear", "AllClear", "AC", "Clear", "C"]

func cuProbeShows(_ texts: [String], _ number: String) -> Bool {
    texts.contains { $0.replacingOccurrences(of: "\u{200E}", with: "").trimmingCharacters(in: .whitespaces) == number }
}

@MainActor func cuProbeCalculatorPress(_ app: NSRunningApplication) -> (Bool, CUObject) {
    guard let window = cuProbeFirstWindow(app) else { return (false, ["note": "no Calculator window"]) }
    let buttons = cuProbeDescendants(window).filter { cuRole($0) == "AXButton" }
    let sample = buttons.prefix(30).map { cuProbeLabels($0).joined(separator: "|") }
    let sequence: [[String]] = [cuProbeClearNames, ["7", "seven"], ["+", "add", "plus"], ["2", "two"], ["=", "equals"]]
    var pressed: [String] = []
    for names in sequence {
        guard let button = cuProbeCalculatorButton(window, names) else { return (false, ["missing": names[0], "buttons": sample]) }
        let status = AXUIElementPerformAction(button, "AXPress" as CFString)
        pressed.append("\(names[0]):\(status.rawValue)")
        usleep(80_000)
    }
    let texts = cuProbeCalculatorTexts(window)
    return (cuProbeShows(texts, "9"), ["pressed": pressed, "display": texts, "buttonSample": sample])
}

/// Clears with AXPress, then clicks "5" with posted mouse events addressed to the window.
@MainActor func cuProbeCalculatorPostedClick(_ app: NSRunningApplication) async -> (Bool, CUObject) {
    guard let window = cuProbeFirstWindow(app), let number = cuWindowNumber(window) else { return (false, ["note": "no Calculator window"]) }
    if let clear = cuProbeCalculatorButton(window, cuProbeClearNames) { AXUIElementPerformAction(clear, "AXPress" as CFString) }
    usleep(100_000)
    guard let five = cuProbeCalculatorButton(window, ["5", "five"]), let frame = cuFrame(of: five) else { return (false, ["note": "no 5 button"]) }
    let point = CGPoint(x: frame.midX, y: frame.midY)
    // Like the engine: make the window key without activating Calculator, so the click is not
    // spent bringing the window forward.
    let focused = cuFocusWithoutActivating(pid: app.processIdentifier, window: number)
    try? await Task.sleep(nanoseconds: 50_000_000)
    let poster = CUPoster(pid: app.processIdentifier)
    poster.mouse(CUMouseEvent(kind: .move, button: .left, point: point, clickState: 0, delayMs: 0), window: number)
    try? await Task.sleep(nanoseconds: 30_000_000)
    poster.mouse(CUMouseEvent(kind: .down, button: .left, point: point, clickState: 1, delayMs: 0), window: number)
    try? await Task.sleep(nanoseconds: 40_000_000)
    poster.mouse(CUMouseEvent(kind: .up, button: .left, point: point, clickState: 1, delayMs: 0), window: number)
    try? await Task.sleep(nanoseconds: 300_000_000)
    let texts = cuProbeCalculatorTexts(window)
    return (cuProbeShows(texts, "5"), ["windowOnScreen": cuServerWindowInfo([number])[number]?.onScreen ?? false, "focusedWithoutActivating": focused, "point": [point.x, point.y], "display": texts])
}

// MARK: TextEdit

func cuProbeMenuItem(_ app: AXUIElement, _ path: [String]) -> AXUIElement? {
    guard let bar = cuElementAttribute(app, "AXMenuBar") else { return nil }
    var current: AXUIElement = bar
    for title in path {
        var children = (cuAttribute(current, "AXChildren") as? [AXUIElement]) ?? []
        // A menu bar item holds its menu, which holds the items.
        if children.count == 1, cuRole(children[0]) == "AXMenu" { children = (cuAttribute(children[0], "AXChildren") as? [AXUIElement]) ?? [] }
        guard let next = children.first(where: { (cuAttribute($0, "AXTitle") as? String) == title }) else { return nil }
        current = next
    }
    return current
}

func cuProbeTextArea(_ window: AXUIElement) -> AXUIElement? { cuProbeDescendants(window, limit: 300).first { cuRole($0) == "AXTextArea" } }

func cuProbeText(_ window: AXUIElement) -> String { cuProbeTextArea(window).flatMap { cuAttribute($0, "AXValue") as? String } ?? "" }

@MainActor func cuProbeNewDocument(_ app: NSRunningApplication) async -> (AXUIElement?, CUObject) {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    let before = cuProbeServerWindows(pid: app.processIdentifier)
    guard let item = cuProbeMenuItem(element, ["File", "New"]) else {
        let bar = cuElementAttribute(element, "AXMenuBar")
        let titles = bar.map { ((cuAttribute($0, "AXChildren") as? [AXUIElement]) ?? []).compactMap { cuAttribute($0, "AXTitle") as? String } } ?? []
        return (nil, ["note": "File > New not found", "menuBar": bar != nil, "titles": titles])
    }
    let status = AXUIElementPerformAction(item, "AXPress" as CFString)
    var created: CGWindowID?
    for _ in 0..<30 where created == nil {
        try? await Task.sleep(nanoseconds: 100_000_000)
        created = cuProbeServerWindows(pid: app.processIdentifier).subtracting(before).max()
    }
    guard let created else { return (nil, ["pressStatus": status.rawValue, "note": "no new window within 3 s"]) }
    // Remember it before anything else can fail, so cleanup can close it.
    cuProbeRemember(created)
    let (window, reachedBy) = await cuProbeReach(app, created)
    var detail: CUObject = ["pressStatus": status.rawValue, "window": Int(created), "reachedBy": reachedBy,
                            "axWindowsListed": ((cuAttribute(element, "AXWindows") as? [AXUIElement]) ?? []).count,
                            "onScreen": cuServerWindowInfo([created])[created]?.onScreen ?? false]
    guard let window else {
        detail["note"] = "the new window is not reachable through accessibility"
        return (nil, detail)
    }
    detail["title"] = cuAttribute(window, "AXTitle") as? String ?? ""
    return (window, detail)
}

func cuProbeSetValue(_ window: AXUIElement) -> (Bool, CUObject) {
    guard let area = cuProbeTextArea(window) else { return (false, ["note": "no text area"]) }
    let status = AXUIElementSetAttributeValue(area, "AXValue" as CFString, "ace-ax-value" as CFString)
    let text = cuProbeText(window)
    return (text == "ace-ax-value", ["status": status.rawValue, "text": text])
}

func cuProbeSelectedTextInsert(_ window: AXUIElement) -> (Bool, CUObject) {
    guard let area = cuProbeTextArea(window) else { return (false, ["note": "no text area"]) }
    var range = CFRange(location: cuProbeText(window).utf16.count, length: 0)
    if let value = AXValueCreate(.cfRange, &range) { AXUIElementSetAttributeValue(area, "AXSelectedTextRange" as CFString, value) }
    let status = AXUIElementSetAttributeValue(area, "AXSelectedText" as CFString, " ax-insert" as CFString)
    let text = cuProbeText(window)
    return (text.contains("ax-insert"), ["status": status.rawValue, "text": text])
}

@MainActor func cuProbeSelectAll(_ app: NSRunningApplication, document: AXUIElement) async -> (Bool, CUObject) {
    let element = AXUIElementCreateApplication(app.processIdentifier)
    guard let number = cuWindowNumber(document) else { return (false, ["note": "no window number"]) }
    // Menu commands go to the key window; make ours key without activating TextEdit.
    let focused = cuFocusWithoutActivating(pid: app.processIdentifier, window: number)
    try? await Task.sleep(nanoseconds: 100_000_000)
    if let area = cuProbeTextArea(document) { AXUIElementSetAttributeValue(area, "AXFocused" as CFString, kCFBooleanTrue) }
    guard let item = cuProbeMenuItem(element, ["Edit", "Select All"]) else { return (false, ["note": "Edit > Select All not found"]) }
    let enabled = cuAttribute(item, "AXEnabled") as? Bool
    let status = AXUIElementPerformAction(item, "AXPress" as CFString)
    try? await Task.sleep(nanoseconds: 500_000_000)
    let length = cuProbeText(document).utf16.count
    var selected = CFRange(location: 0, length: 0)
    if let area = cuProbeTextArea(document), let raw = cuAttribute(area, "AXSelectedTextRange"), CFGetTypeID(raw) == AXValueGetTypeID() {
        AXValueGetValue(raw as! AXValue, .cfRange, &selected)
    }
    return (length > 0 && selected.length == length, ["focusedWithoutActivating": focused, "itemEnabled": enabled ?? "unknown", "pressStatus": status.rawValue, "selected": selected.length, "textLength": length])
}

/// Types a marker with key events posted to TextEdit's pid: one Unicode chunk and one raw key code.
@MainActor func cuProbePostedKeys(_ app: NSRunningApplication, document: AXUIElement) async -> (Bool, CUObject) {
    guard let number = cuWindowNumber(document), let area = cuProbeTextArea(document) else { return (false, ["note": "no text area"]) }
    let focused = cuFocusWithoutActivating(pid: app.processIdentifier, window: number)
    var end = CFRange(location: cuProbeText(document).utf16.count, length: 0)
    if let value = AXValueCreate(.cfRange, &end) { AXUIElementSetAttributeValue(area, "AXSelectedTextRange" as CFString, value) }
    try? await Task.sleep(nanoseconds: 100_000_000)
    let before = cuProbeText(document)
    let poster = CUPoster(pid: app.processIdentifier)
    poster.typeChunk(" posted-chunk")
    try? await Task.sleep(nanoseconds: 50_000_000)
    poster.key(7) // the "x" key on ANSI layouts, with no Unicode override
    try? await Task.sleep(nanoseconds: 400_000_000)
    let after = cuProbeText(document)
    let chunk = after.contains("posted-chunk")
    let rawKey = after.count > before.count + " posted-chunk".count
    return (chunk, ["focusedWithoutActivating": focused, "chunkArrived": chunk, "rawKeyArrived": rawKey, "text": after])
}

@MainActor func cuProbeCloseDocument(_ app: NSRunningApplication, window: AXUIElement) async -> (ok: Bool, detail: CUObject) {
    let closed = cuProbeCloseDocumentNow(window)
    try? await Task.sleep(nanoseconds: 300_000_000)
    let element = AXUIElementCreateApplication(app.processIdentifier)
    let number = cuWindowNumber(window)
    let stillOpen = ((cuAttribute(element, "AXWindows") as? [AXUIElement]) ?? []).contains { cuWindowNumber($0) == number && number != nil }
    return (closed && !stillOpen, ["pressedDelete": closed, "stillOpen": stillOpen])
}

/// Presses the window's close button, then "Delete" / "Don't Save" in the sheet that asks
/// whether to keep the new document.
func cuProbeCloseDocumentNow(_ window: AXUIElement) -> Bool {
    guard let close = cuElementAttribute(window, "AXCloseButton") else { return false }
    AXUIElementPerformAction(close, "AXPress" as CFString)
    let discard: Set<String> = ["Delete", "Don't Save", "Don\u{2019}t Save"]
    for _ in 0..<20 {
        usleep(100_000)
        let sheets = ((cuAttribute(window, "AXChildren") as? [AXUIElement]) ?? []).filter { cuRole($0) == "AXSheet" }
        for sheet in sheets {
            if let button = cuProbeDescendants(sheet, limit: 200).first(where: { cuRole($0) == "AXButton" && discard.contains(cuAttribute($0, "AXTitle") as? String ?? "") }) {
                return AXUIElementPerformAction(button, "AXPress" as CFString) == .success
            }
        }
        // An unedited document closes without asking.
        if cuAttribute(window, "AXRole") == nil { return true }
    }
    return false
}
