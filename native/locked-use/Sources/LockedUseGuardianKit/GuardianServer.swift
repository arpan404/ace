import Foundation
import LockedUseCore
import LockedUseSystem

public enum LockedUseGuardianEvent: Equatable, Sendable {
    case armed(attemptID: String, owner: Int32)
    case disarmed(attemptID: String)
    case relockRequested(LockedUseGuardianTrip)
    case relockFailed(LockedUseGuardianTrip)
}

/// XPC shell around `LockedUseWatchdog`, run as its own supervised process. All state is
/// confined to `queue`; the tick scheduler keeps firing whether or not any owner is alive.
public final class LockedUseGuardianServer: NSObject, NSXPCListenerDelegate, @unchecked Sendable {
    private let listener: NSXPCListener
    private let requirement: String?
    private let lock: LockedUseLockSink
    private let now: () -> UInt64
    private let watch: LockedUseProcessWatcher
    private let events: (LockedUseGuardianEvent) -> Void
    let queue: DispatchQueue
    private var watchdog = LockedUseWatchdog()
    private var stopWatching: (() -> Void)?

    /// `requirement` pins the owner's code signature. Production passes the team-pinned
    /// requirement for the screen helper; only in-process tests pass nil.
    public init(listener: NSXPCListener, requirement: String?, lock: LockedUseLockSink, now: @escaping () -> UInt64,
                queue: DispatchQueue = DispatchQueue(label: "dev.ace.locked-use.guardian"),
                watch: @escaping LockedUseProcessWatcher = lockedUseWatchProcessExit,
                events: @escaping (LockedUseGuardianEvent) -> Void = { _ in }) {
        self.listener = listener
        self.requirement = requirement
        self.lock = lock
        self.now = now
        self.queue = queue
        self.watch = watch
        self.events = events
        super.init()
        listener.delegate = self
    }

    public func start() { listener.resume() }
    public func stop() { listener.invalidate() }

    /// Drive at least every 100 ms from an independent timer.
    public func tick() { queue.async { [self] in relock(watchdog.tick(now: now())) } }

    public var state: LockedUseWatchdog.State { queue.sync { watchdog.state } }

    public func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        if let requirement { connection.setCodeSigningRequirement(requirement) }
        let pid = connection.processIdentifier
        let uid = connection.effectiveUserIdentifier
        connection.exportedInterface = NSXPCInterface(with: LockedUseGuardianLink.self)
        connection.exportedObject = GuardianSession(server: self, owner: pid, user: uid)
        let dropped: () -> Void = { [weak self] in self?.linkDropped(owner: pid) }
        connection.invalidationHandler = dropped
        connection.interruptionHandler = dropped
        connection.resume()
        return true
    }

    func arm(_ data: Data, owner: Int32, user: uid_t) -> Bool {
        queue.sync {
            guard data.count <= 4096, let scope = try? JSONDecoder().decode(LockedUseScope.self, from: data),
                  scope.userID == user else { return false }
            do {
                let wasArmed = watchdog.armedAttempt == scope.attemptID
                if let trip = try watchdog.arm(attempt: scope.attemptID, owner: owner, now: now()) { relock(trip); return false }
                if !wasArmed {
                    stopWatching?()
                    stopWatching = watch(owner, queue) { [weak self] in self?.ownerExited(owner) }
                    events(.armed(attemptID: scope.attemptID, owner: owner))
                }
                return true
            } catch { return false }
        }
    }

    func heartbeat(_ attempt: String, owner: Int32) -> Bool {
        queue.sync {
            let result = watchdog.heartbeat(attempt: attempt, owner: owner, now: now())
            relock(result.trip)
            return result.alive
        }
    }

    func disarm(_ attempt: String, owner: Int32) -> Bool {
        queue.sync {
            guard watchdog.disarm(attempt: attempt, owner: owner) else { return false }
            stopWatching?()
            stopWatching = nil
            events(.disarmed(attemptID: attempt))
            return true
        }
    }

    private func linkDropped(owner: Int32) { queue.async { [self] in relock(watchdog.linkDropped(owner: owner, now: now())) } }
    private func ownerExited(_ pid: Int32) { relock(watchdog.ownerExited(pid, now: now())) }

    /// Runs on `queue`. The lock sink needs no cooperation from the dead or silent owner.
    private func relock(_ trip: LockedUseGuardianTrip?) {
        guard let trip else { return }
        if case .tripped = watchdog.state { stopWatching?(); stopWatching = nil }
        do {
            try lock.requestLock()
            events(.relockRequested(trip))
        } catch { events(.relockFailed(trip)) }
    }
}

private final class GuardianSession: NSObject, LockedUseGuardianLink {
    private weak var server: LockedUseGuardianServer?
    private let owner: Int32
    private let user: uid_t

    init(server: LockedUseGuardianServer, owner: Int32, user: uid_t) {
        self.server = server
        self.owner = owner
        self.user = user
    }

    func arm(scope: Data, reply: @escaping (Bool) -> Void) { reply(server?.arm(scope, owner: owner, user: user) ?? false) }
    func heartbeat(attempt: String, reply: @escaping (Bool) -> Void) { reply(server?.heartbeat(attempt, owner: owner) ?? false) }
    func disarm(attempt: String, reply: @escaping (Bool) -> Void) { reply(server?.disarm(attempt, owner: owner) ?? false) }
    func ping(reply: @escaping (Bool) -> Void) { reply(server != nil) }
}
