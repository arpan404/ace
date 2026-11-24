import Foundation

/// Decides what the connections do when the app leaves and returns to the foreground.
///
/// iOS does not let an app keep a socket open for long. What it gives is a background task
/// assertion: a grace period of up to about 30 seconds after the app leaves the screen, which ends
/// when the task is released or iOS calls its expiration handler. This holds one while
/// "Run in background" (the system's Background App Refresh) is on, so a quick switch to another
/// app keeps the sockets alive. After a longer absence iOS suspends the app and the sockets die;
/// push and the background refresh cover that time, and on return the clients catch up from their
/// last cursor, so cached content stays on screen.
///
/// Pure: the clock is passed in and the effects come back as values for `BackgroundKeeper`.
struct BackgroundHold: Equatable {
    enum Phase: Equatable { case active, inactive, background }
    enum Effect: Equatable {
        /// Ask iOS for a background task assertion.
        case beginTask
        /// Release the assertion.
        case endTask
        /// Back on screen after leaving it: check every socket now instead of at its next beat.
        case wake
    }

    /// The system's Background App Refresh is on for ace.
    var enabled: Bool
    private(set) var holding = false
    /// When the app left the screen, while it is away.
    private(set) var leftAt: Date?

    init(enabled: Bool) { self.enabled = enabled }

    mutating func phase(_ phase: Phase, now: Date) -> [Effect] {
        switch phase {
        case .inactive:
            // The app switcher, Control Centre, a call banner: still on screen, nothing to tear down.
            return []
        case .background:
            if leftAt == nil { leftAt = now }
            guard enabled, !holding else { return [] }
            holding = true
            return [.beginTask]
        case .active:
            var effects: [Effect] = []
            if holding { holding = false; effects.append(.endTask) }
            if leftAt != nil { leftAt = nil; effects.append(.wake) }
            return effects
        }
    }

    /// iOS is taking the grace period back. The assertion must be ended in the handler, or iOS
    /// kills the app; the sockets are then left to die and are checked on return.
    mutating func expired() -> [Effect] {
        guard holding else { return [] }
        holding = false
        return [.endTask]
    }

    /// The person turned Background App Refresh off or on while the app is away.
    mutating func setEnabled(_ on: Bool) -> [Effect] {
        enabled = on
        guard !on, holding else { return [] }
        holding = false
        return [.endTask]
    }
}
