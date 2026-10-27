import Foundation
import LockedUseCore
import LockedUseGuardianKit
import LockedUseRuntime

public enum LockedUseGuardianClientError: Error, Equatable { case unreachable, refused, stale }

/// The coordinator's view of the separately supervised guardian. Readiness requires an
/// acknowledged arm and a heartbeat acknowledged within the last 500 ms; any link failure
/// makes the coordinator stop, while the guardian itself relocks on the same failure.
@MainActor public final class LockedUseGuardianClient: LockedUseGuardian {
    public static let ackFreshness: UInt64 = 500_000_000
    private let connect: () -> NSXPCConnection
    private let now: () -> UInt64
    private var connection: NSXPCConnection?
    private var armed: String?
    private var lastAck: UInt64 = 0
    private var lost = false

    /// `connect` returns a configured, not yet resumed connection (signing requirement set).
    public init(connect: @escaping () -> NSXPCConnection, now: @escaping () -> UInt64) {
        self.connect = connect
        self.now = now
    }

    /// Installation check: the guardian answers on its service name. Never blocks the main
    /// thread; `done` runs on the main actor. It uses the same link as arm and heartbeat,
    /// because the guardian treats any dropped connection from this process as a lost link.
    public func ping(done: @escaping @MainActor (Bool) -> Void) {
        lockedUseCallAsync(link(), timeout: .milliseconds(500), { (proxy: LockedUseGuardianLink, reply) in
            proxy.ping(reply: reply)
        }, done: done)
    }

    public func arm(_ scope: LockedUseScope) throws {
        let data = try JSONEncoder().encode(scope)
        let ok = lockedUseCall(link(), timeout: .milliseconds(500)) { (proxy: LockedUseGuardianLink, reply) in
            proxy.arm(scope: data, reply: reply)
        }
        guard ok, !lost else { throw LockedUseGuardianClientError.refused }
        armed = scope.attemptID
        lastAck = now()
    }

    public func heartbeat(_ scope: LockedUseScope) throws {
        guard armed == scope.attemptID, !lost, let connection else { throw LockedUseGuardianClientError.unreachable }
        guard fresh else { throw LockedUseGuardianClientError.stale }
        let attempt = scope.attemptID
        let proxy = connection.remoteObjectProxyWithErrorHandler { [weak self] _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.lost = true } }
        } as? LockedUseGuardianLink
        proxy?.heartbeat(attempt: attempt) { [weak self] alive in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, self.armed == attempt else { return }
                    if alive { self.lastAck = self.now() } else { self.lost = true }
                }
            }
        }
    }

    public func ready(_ scope: LockedUseScope) -> Bool { armed == scope.attemptID && !lost && fresh }

    public func disarmAfterConfirmedLock(_ scope: LockedUseScope) {
        guard armed == scope.attemptID, let connection else { return }
        _ = lockedUseCall(connection, timeout: .milliseconds(500)) { (proxy: LockedUseGuardianLink, reply) in
            proxy.disarm(attempt: scope.attemptID, reply: reply)
        }
        armed = nil
    }

    private var fresh: Bool {
        let at = now()
        return at >= lastAck && at - lastAck < Self.ackFreshness
    }

    private func link() -> NSXPCConnection {
        if let connection, !lost { return connection }
        let next = connect()
        next.remoteObjectInterface = NSXPCInterface(with: LockedUseGuardianLink.self)
        let dropped: () -> Void = { [weak self, weak next] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, self.connection === next else { return }
                    self.lost = true
                }
            }
        }
        next.invalidationHandler = dropped
        next.interruptionHandler = dropped
        next.resume()
        connection?.invalidate()
        connection = next
        lost = false
        armed = nil
        return next
    }
}
