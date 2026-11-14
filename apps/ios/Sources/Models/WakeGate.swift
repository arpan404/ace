import Foundation
import os

/// When to wake every machine's client to check its socket (an interface change, coming back
/// from the background). A wake makes the shared client ping a ready socket and wait
/// `probeWindow` for the daemon, and a second wake restarts that wait, so updates arriving under
/// five seconds apart could otherwise keep a silent socket marked ready for as long as they go
/// on. So a wake inside the window of the last one doesn't go out at once; instead one trailing
/// wake goes out just after that window, once its probe has settled, and its ping leaves after
/// the latest change.
///
/// Whether that probe proves the socket is alive *after* the change is the shared client's
/// part: once a probe is satisfied only by the answer to its own ping, a socket that dies at
/// any change is noticed within `bound` of it. Until then a pong already in flight before the
/// change can satisfy the trailing probe, and that socket is found by the regular heartbeat.
@MainActor final class WakeGate {
    /// Runs `work` after `delay` milliseconds; the handle cancels it from any thread.
    typealias Schedule = @MainActor (_ delay: Double, _ work: @escaping @MainActor () -> Void) -> @Sendable () -> Void

    /// How long the shared client gives a woken socket to answer (`wakeProbeMs`), in ms.
    static let probeWindow: Double = 5_000
    /// After the window, so the window's own deadline (on the client's thread) settles first.
    static let settle: Double = 250
    /// From an interface change to a socket that died at it being noticed, in ms: at most one
    /// window to the trailing wake, the settle margin, then that wake's own window.
    static let bound = 2 * probeWindow + settle

    private let now: () -> Double
    private let schedule: Schedule
    private let wake: @MainActor () -> Void
    private var last: Double?
    /// The pending trailing wake's cancel handle, readable from `deinit`.
    private let trailing = OSAllocatedUnfairLock<(@Sendable () -> Void)?>(initialState: nil)

    init(now: @escaping () -> Double, schedule: @escaping Schedule = WakeGate.sleeping, wake: @escaping @MainActor () -> Void) {
        self.now = now; self.schedule = schedule; self.wake = wake
    }
    deinit { trailing.withLock { $0.take() }?() }

    /// Wakes now, or once the outstanding probe's window has passed.
    func request() {
        let at = now()
        if let last, at - last < Self.probeWindow {
            guard trailing.withLock({ $0 == nil }) else { return }
            let cancel = schedule(last + Self.probeWindow + Self.settle - at) { [weak self] in
                guard let self else { return }
                self.trailing.withLock { $0 = nil }
                self.request()
            }
            trailing.withLock { $0 = cancel }
            return
        }
        // A new window: anything still waiting is answered by this wake.
        cancel()
        last = at
        wake()
    }
    /// Drops a pending trailing wake: nothing is left to check (signed out, every machine let go).
    func cancel() {
        trailing.withLock { $0.take() }?()
    }

    /// The app's scheduler: a main-actor task that sleeps, cancelled by its handle.
    static let sleeping: Schedule = { delay, work in
        let task = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(Int(delay.rounded(.up))))
            if !Task.isCancelled { work() }
        }
        return { task.cancel() }
    }
}
