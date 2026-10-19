import AppKit
import IOKit.pwr_mgt

/// The facts a guard decides on, read from the system by `cuGuardFacts`.
struct CUGuardFacts {
    let locked: Bool
    let appFrontmost: Bool
    let secondsSinceHumanInput: Double
    let stopRequested: Bool
    var cancelled = false
}

/// Whether an action may run now. Pure: the person always wins over the agent.
func cuGuard(_ facts: CUGuardFacts, app: String) throws {
    if facts.cancelled { throw CUError("cancelled", cuCancelledMessage) }
    if facts.stopRequested {
        throw CUError("stopped_by_person", "The person pressed Esc to stop computer use. Stop acting and ask them how they want to continue.")
    }
    if facts.locked {
        throw CUError("screen_locked", "The Mac is locked, so apps can't be operated. Ask the person to unlock it, then try again.")
    }
    if facts.appFrontmost && facts.secondsSinceHumanInput < 1.5 {
        throw CUError("person_active", "The person is using \(app) right now. Wait a few seconds and try again, or work in another app.")
    }
}

func cuScreenLocked() -> Bool {
    (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false
}

/// Seconds since the person last touched a real keyboard, mouse or trackpad. Events this
/// helper posts to a process do not count.
func cuSecondsSinceHumanInput() -> Double {
    guard let any = CGEventType(rawValue: ~0) else { return .infinity }
    return CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: any)
}

/// Keeps the display awake while the agent acts, so the Mac does not lock mid-task.
@MainActor final class CUAwake {
    private var assertion: IOPMAssertionID = 0
    private var held = false
    func hold() {
        guard !held else { return }
        held = IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleDisplaySleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), "ace computer use" as CFString, &assertion) == kIOReturnSuccess
    }
    func release() {
        guard held else { return }
        IOPMAssertionRelease(assertion)
        held = false
    }
}
