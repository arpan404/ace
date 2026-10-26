import AppKit
import ApplicationServices

/// How the target window becomes the app's key window before keyboard, menu and click steps.
///
/// AppKit hands a key window, a main window and a first responder only to the app it believes
/// is active. A background app's first-responder commands (Copy, Paste, Bold, Save…) and its
/// ⌘ shortcuts therefore find no target. For a window on screen the SkyLight focus records do
/// the job. For a window on another Space or behind a full-screen app they have no effect, so
/// the helper tells the app itself that it is active (the "application activated" AppKit event,
/// posted to its process only) and makes the window main through accessibility. The window
/// server never hears of it: the frontmost app, the menu bar, the Space and the person's
/// keyboard stay where they were. The app is told it is inactive again when the request ends.
enum CUKeyRoute: Equatable {
    /// The app is really frontmost; its own key window is already live.
    case frontmost
    /// A window on the current screen: focus records (see `cuFocusWithoutActivating`).
    case focusRecords
    /// A window on another Space or behind a full-screen app: activation inside the app only.
    case innerActivation
    /// No window-server window to make key (Finder's desktop, a window with no id).
    case none
}

struct CUKeyRouteFacts: Equatable {
    var appFrontmost: Bool
    var hasWindowNumber: Bool
    var onScreen: Bool
    var otherSpace: Bool
    var minimized: Bool
}

func cuKeyRoute(_ facts: CUKeyRouteFacts) -> CUKeyRoute {
    if facts.appFrontmost { return .frontmost }
    guard facts.hasWindowNumber else { return .none }
    if facts.onScreen { return .focusRecords }
    // A minimized window is not drawn anywhere, so there is nothing to gain by pretending.
    if facts.otherSpace, !facts.minimized { return .innerActivation }
    return .focusRecords
}

/// AppKit's "application activated" and "application deactivated" events (appKitDefined
/// subtypes 1 and 2), posted to one process. AppKit updates its own active state, key window
/// and main window from them.
func cuPostInnerActivation(pid: pid_t, active: Bool) -> Bool {
    let subtype: Int16 = active ? 1 : 2
    guard let event = NSEvent.otherEvent(with: .appKitDefined, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                         windowNumber: 0, context: nil, subtype: subtype, data1: 0, data2: 0)?.cgEvent else { return false }
    event.postToPid(pid)
    return true
}

/// What AppKit inside the app believes: `AXFrontmost` reads its own active flag, unlike
/// `NSRunningApplication.isActive`, which is the window server's answer.
func cuAppBelievesActive(_ application: AXUIElement) -> Bool? {
    (cuAttribute(application, "AXFrontmost") as? NSNumber)?.boolValue
}

extension CUAppSession {
    /// Activates the app inside itself and waits briefly (up to ~200 ms) until it says so.
    /// Returns whether AppKit took it.
    func activateInside() -> Bool {
        if cuAppBelievesActive(element) == true { innerActive = true; return true }
        guard cuPostInnerActivation(pid: pid, active: true) else { return false }
        // Deactivate later even if the app is slow to confirm: deactivating an inactive app is harmless.
        innerActive = true
        for _ in 0..<20 {
            usleep(10_000)
            if cuAppBelievesActive(element) == true { return true }
        }
        return false
    }

    /// Hands the app back its real state: inactive, unless the person brought it forward meanwhile.
    func deactivateInside() {
        guard innerActive else { return }
        innerActive = false
        if !app.isActive, !app.isTerminated { _ = cuPostInnerActivation(pid: pid, active: false) }
    }
}
