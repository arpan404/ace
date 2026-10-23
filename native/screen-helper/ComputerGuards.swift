import AppKit

/// The facts a guard decides on, read from the system by `cuGuardFacts`.
struct CUGuardFacts {
    let locked: Bool
    let appFrontmost: Bool
    let secondsSinceHumanInput: Double
    let stopRequested: Bool
    var cancelled = false
    /// Unknown focus is conservative; another window of the same app is independent.
    var conflictsWithHuman = true
    var sessionAvailable = true
}

struct CUHumanTargetFacts {
    var observing: Bool
    var explicitTarget: Bool
    var sameWindow: Bool
    var focusKnown: Bool
    var containsFocus: Bool
    var pointerAction: Bool
    var cursorOnTarget: Bool
}

/// A shared tab can accept an independent element action, but never an edit to the
/// person's focused field or a pointer action where the person is pointing.
func cuConflictsWithHuman(_ facts: CUHumanTargetFacts) -> Bool {
    if facts.observing { return false }
    if !facts.explicitTarget { return facts.sameWindow }
    return !facts.focusKnown || facts.containsFocus || (facts.pointerAction && facts.cursorOnTarget)
}

/// Whether an action may run now. Pure: the person always wins over the agent.
func cuGuard(_ facts: CUGuardFacts, app: String) throws {
    if facts.cancelled { throw CUError("cancelled", cuCancelledMessage) }
    if facts.stopRequested {
        throw CUError("stopped_by_person", "The person pressed Esc to stop computer use. Stop acting and ask them how they want to continue.")
    }
    guard facts.sessionAvailable else { throw cuSessionUnavailableError }
    // Accessibility targets the app, independently of the lock screen. The previous
    // frontmost app can still report active while locked; that is not human takeover.
    if !facts.locked && facts.appFrontmost && facts.conflictsWithHuman && facts.secondsSinceHumanInput < 1.5 {
        throw CUError("person_active", "The person is using this control in \(app) right now. Select another element or window, or wait before trying again.")
    }
}

func cuScreenLocked() -> Bool {
    cuSessionStatus() != .active
}

/// Seconds since the person last touched a real keyboard, mouse or trackpad. Events this
/// helper posts to a process do not count.
func cuSecondsSinceHumanInput() -> Double {
    guard let any = CGEventType(rawValue: ~0) else { return .infinity }
    return CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: any)
}
