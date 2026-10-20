import AppKit

/// What the front guard decides on: the frontmost app before and after an engine step, the
/// app the step acted on, and whether the person touched a real input device meanwhile.
struct CUFrontFacts: Equatable {
    let before: pid_t?
    let after: pid_t?
    let target: pid_t
    let personActed: Bool
}

/// Whether an engine step took the front from the person: the app it acted on became
/// frontmost, from another app, with no real input from the person in between. Pure.
/// Anything else (the person switching apps, a third app taking the front) is not ours.
func cuStepTookFront(_ facts: CUFrontFacts) -> Bool {
    guard let before = facts.before, before != facts.target, facts.after == facts.target else { return false }
    return !facts.personActed
}

/// The system edges the front guard reads and acts through. Tests substitute them.
struct CUFrontSystem {
    var frontmost: () -> pid_t?
    var secondsSinceHumanInput: () -> Double
    var uptime: () -> Double
    /// Brings the person's app back; false when macOS refused.
    var restore: (pid_t) -> Bool
    var name: (pid_t) -> String

    @MainActor static let live = CUFrontSystem(
        frontmost: { NSWorkspace.shared.frontmostApplication?.processIdentifier },
        secondsSinceHumanInput: cuSecondsSinceHumanInput,
        uptime: { ProcessInfo.processInfo.systemUptime },
        restore: { pid in NSRunningApplication(processIdentifier: pid)?.activate(options: []) ?? false },
        name: { pid in NSRunningApplication(processIdentifier: pid)?.localizedName ?? "the person's app" })
}

/// The engine acts in the background: launching, clicking and typing never change the
/// person's frontmost app (ADR 0087). Some apps still bring themselves forward when acted on,
/// so every step that is not `activate` is bracketed: if the target took the front, the
/// person's app is brought straight back and the step's line says so.
@MainActor struct CUFrontGuard {
    let system: CUFrontSystem
    private let before: pid_t?
    private let started: Double

    /// Remembers the frontmost app now, before the step.
    init(system: CUFrontSystem) {
        self.system = system
        before = system.frontmost()
        started = system.uptime()
    }

    /// nil when the front is as the person left it, else a note for the step's result.
    func check(target: pid_t, app: String) -> String? {
        let elapsed = system.uptime() - started
        let facts = CUFrontFacts(before: before, after: system.frontmost(), target: target,
                                 personActed: system.secondsSinceHumanInput() <= elapsed)
        guard cuStepTookFront(facts), let person = facts.before else { return nil }
        let name = system.name(person)
        return system.restore(person)
            ? "\(app) brought itself to the front; \(name) was put back in front"
            : "\(app) brought itself to the front and macOS would not put \(name) back"
    }
}
