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
/// Driven by UIKit's lifecycle notifications, not SwiftUI's scene phase: UIKit grants the
/// assertion asynchronously, so it is asked for as soon as the app resigns active, before iOS
/// can suspend it, and a fast switch that SwiftUI coalesces back to active still delivers each
/// notification. Resigning alone (the app switcher, Control Centre, a call banner) keeps the
/// app on screen; only entering the background makes the return check the sockets.
///
/// Pure: the effects come back as values for `BackgroundKeeper`.
struct BackgroundHold: Equatable {
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
    /// The app reached the background since it was last active.
    private(set) var away = false

    init(enabled: Bool) { self.enabled = enabled }

    /// `willResignActive`: the app may be about to leave the screen, with each machine's
    /// connection state. Background time is only worth asking for while a socket is ready or
    /// still being opened; with none (the pairing screen of a fresh install, every machine
    /// offline or refused) there is nothing to keep.
    mutating func resignActive(connections: [String]) -> [Effect] {
        guard enabled, connections.contains(where: Self.socketWorking), !holding else { return [] }
        holding = true
        return [.beginTask]
    }

    /// A connection state whose socket is open or being opened (the client SDK's
    /// `ConnectionState`). `offline` waits for the network and `fatal` for the person.
    static func socketWorking(_ state: String) -> Bool {
        ["connecting", "starting", "ready", "reconnecting"].contains(state)
    }

    /// `didEnterBackground`: the app left the screen, so its sockets may die while it is away.
    mutating func enteredBackground() -> [Effect] {
        away = true
        return []
    }

    /// `didBecomeActive`: back on screen.
    mutating func becameActive() -> [Effect] {
        var effects: [Effect] = []
        if holding { holding = false; effects.append(.endTask) }
        if away { away = false; effects.append(.wake) }
        return effects
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
