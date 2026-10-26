import Foundation

/// The guardian's XPC surface. The owner's pid and user come from the kernel-attested
/// connection, never from these arguments. There is no unlock or disable operation.
@objc(ACELockedUseGuardianLink) public protocol LockedUseGuardianLink {
    /// `scope` is a JSON-encoded `LockedUseScope`; its userID must equal the peer's effective user.
    @objc(armScope:reply:) func arm(scope: Data, reply: @escaping (Bool) -> Void)
    @objc(heartbeatAttempt:reply:) func heartbeat(attempt: String, reply: @escaping (Bool) -> Void)
    @objc(disarmAttempt:reply:) func disarm(attempt: String, reply: @escaping (Bool) -> Void)
    /// Liveness only, for the installation check. Arms nothing.
    @objc(pingWithReply:) func ping(reply: @escaping (Bool) -> Void)
}

/// Calls `onExit` once when `pid` exits, including if it already exited. Returns a cancel.
public typealias LockedUseProcessWatcher = (_ pid: Int32, _ queue: DispatchQueue, _ onExit: @escaping () -> Void) -> () -> Void

public let lockedUseWatchProcessExit: LockedUseProcessWatcher = { pid, queue, onExit in
    let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: queue)
    var fired = false
    let fire = {
        guard !fired else { return }
        fired = true
        source.cancel()
        onExit()
    }
    source.setEventHandler(handler: fire)
    source.resume()
    // A process that exited before the source was armed produces no event.
    queue.async { if kill(pid, 0) != 0, errno == ESRCH { fire() } }
    return { queue.async { fired = true; source.cancel() } }
}
