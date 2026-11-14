import Foundation

/// When to wake every machine's client to check its socket (an interface change, coming back
/// from the background). A wake makes the shared client ping a ready socket and wait
/// `probeWindow` for anything from the daemon, and a second wake restarts that wait, so updates
/// arriving under five seconds apart could otherwise keep a silent socket marked ready for as
/// long as they go on. So a wake inside the window of the last one doesn't go out at once;
/// instead one trailing wake goes out just after that window, once its probe has settled. Its
/// ping leaves after the latest change, so only an answer sent after the change can satisfy it.
///
/// A socket that dies at any change is therefore noticed within `bound` of that change: at
/// most one window to the trailing wake, plus the settle margin, plus its own window.
@MainActor final class WakeGate {
    /// How long the shared client gives a woken socket to answer (`wakeProbeMs`), in ms.
    static let probeWindow: Double = 5_000
    /// After the window, so the window's own deadline (on the client's thread) settles first.
    static let settle: Double = 250
    /// The longest from an interface change to a socket that died at it being noticed, in ms.
    static let bound = 2 * probeWindow + settle

    private let now: () -> Double
    private let schedule: RouteScheduler
    private let wake: @MainActor () -> Void
    private var last: Double?
    private var trailing: (@MainActor () -> Void)?

    init(now: @escaping () -> Double, schedule: @escaping RouteScheduler, wake: @escaping @MainActor () -> Void) {
        self.now = now; self.schedule = schedule; self.wake = wake
    }

    /// Wakes now, or once the outstanding probe's window has passed.
    func request() {
        let at = now()
        if let last, at - last < Self.probeWindow {
            if trailing == nil {
                trailing = schedule(last + Self.probeWindow + Self.settle - at) { [weak self] in
                    self?.trailing = nil
                    self?.request()
                }
            }
            return
        }
        trailing?()
        trailing = nil
        last = at
        wake()
    }
}
