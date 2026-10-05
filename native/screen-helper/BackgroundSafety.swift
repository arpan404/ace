import AppKit
import ApplicationServices

struct FocusState: Equatable { let pid: pid_t?; let cursor: CGPoint }
struct FocusDecision {
    let restoreFocus: Bool
    let restoreCursor: Bool
    var changed: Bool { restoreFocus || restoreCursor }
    init(before: FocusState, after: FocusState) {
        restoreFocus = before.pid != after.pid
        restoreCursor = before.cursor != after.cursor
    }
}
func shouldRestoreClipboard(savedChange: Int, currentChange: Int) -> Bool { savedChange == currentChange }

@MainActor struct FocusGuard {
    let before: FocusState
    let started: Double
    init() { before = Self.read(); started = ProcessInfo.processInfo.systemUptime }
    static func read() -> FocusState { FocusState(pid: NSWorkspace.shared.frontmostApplication?.processIdentifier, cursor: CGEvent(source: nil)?.location ?? .zero) }
    func verify() throws {
        let decision = FocusDecision(before: before, after: Self.read())
        guard decision.changed else { return }
        let elapsed = ProcessInfo.processInfo.systemUptime - started
        let humanInput = [CGEventType.mouseMoved, .leftMouseDown, .rightMouseDown, .keyDown, .scrollWheel, .flagsChanged, .leftMouseDragged, .rightMouseDragged].contains {
            CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) <= elapsed
        }
        if humanInput { throw HelperError("Focus or cursor changed during human input; the human's desktop was left unchanged", code: "focus_changed") }
        if decision.restoreFocus, let pid = before.pid { _ = NSRunningApplication(processIdentifier: pid)?.activate(options: []) }
        if decision.restoreCursor { CGWarpMouseCursorPosition(before.cursor) }
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
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.hides = true
    let app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
    try await Task.sleep(nanoseconds: 100_000_000)
    try guardState.verify()
    guard app.bundleIdentifier == bundle else { throw HelperError("Launched app identity differs", code: "target_gone") }
    return ["bundleId": bundle, "pid": app.processIdentifier, "mode": "background"]
}

@MainActor func clipboardPaste(_ text: String, post: () throws -> Void) async throws {
    let board = NSPasteboard.general
    let initialChange = board.changeCount
    var bytes = 0
    let saved = try (board.pasteboardItems ?? []).map { item -> NSPasteboardItem in
        let copy = NSPasteboardItem()
        for type in item.types {
            guard let data = item.data(forType: type) else { throw HelperError("Cannot preserve clipboard representation", code: "not_supported") }
            bytes += data.count
            guard bytes <= 8 * 1024 * 1024 else { throw HelperError("Clipboard exceeds preservation budget", code: "busy") }
            copy.setData(data, forType: type)
        }
        return copy
    }
    guard initialChange == board.changeCount else { throw HelperError("Clipboard changed while preserving it", code: "clipboard_changed") }
    board.clearContents()
    guard board.setString(text, forType: .string) else {
        board.clearContents(); if !saved.isEmpty { board.writeObjects(saved) }
        throw HelperError("Cannot prepare paste clipboard", code: "not_supported")
    }
    let ownChange = board.changeCount
    var actionError: Error?
    do { try post(); try await Task.sleep(nanoseconds: 500_000_000) } catch { actionError = error }
    guard shouldRestoreClipboard(savedChange: ownChange, currentChange: board.changeCount) else { throw HelperError("Clipboard changed during paste; human clipboard retained", code: "clipboard_changed") }
    board.clearContents()
    if !saved.isEmpty, !board.writeObjects(saved) { throw HelperError("Clipboard restoration failed", code: "internal") }
    if let actionError { throw actionError }
}
