import Foundation
import Security
import LockedUseCore
import LockedUseIPC
import LockedUseRuntime
import LockedUseSystem

public enum LockedUseDriverEvent: Equatable, Sendable {
    /// The Authorization Services request returned an error. It never reports success:
    /// a granted right is not evidence the desktop unlocked.
    case unlockRequestFailed(attemptID: String, status: Int32)
    case relockRequestFailed(attemptID: String)
}

/// Production session driver. Unlock is only REQUESTED here; `state(of:)` re-reads the
/// session every time, so nothing this driver does can make the coordinator see an
/// unlocked desktop without a matching observation.
@MainActor public final class LockedUseSystemSessionDriver: LockedUseSessionDriver {
    /// The coordinator re-requests relock on every tick while faulted; space OS requests out.
    public static let relockSpacing: UInt64 = 1_000_000_000
    private let readSession: () -> LockedUseSessionFacts?
    private let installation: () -> LockedUseInstallationFacts
    private let unlock: LockedUseUnlockRequesting
    private let lock: LockedUseLockSink
    private let lockQueue: DispatchQueue
    private let now: () -> UInt64
    private let events: (LockedUseDriverEvent) -> Void
    private var binding = LockedUseUnlockBinding()
    private var lastRelock: (attempt: String, at: UInt64)?
    private var relockInFlight = false

    public init(readSession: @escaping () -> LockedUseSessionFacts?, installation: @escaping () -> LockedUseInstallationFacts,
                unlock: LockedUseUnlockRequesting, lock: LockedUseLockSink, now: @escaping () -> UInt64,
                lockQueue: DispatchQueue = DispatchQueue(label: "dev.ace.locked-use.relock"),
                events: @escaping (LockedUseDriverEvent) -> Void) {
        self.readSession = readSession
        self.installation = installation
        self.unlock = unlock
        self.lock = lock
        self.lockQueue = lockQueue
        self.now = now
        self.events = events
    }

    public var verifiedInstallation: Bool { installation().verified }

    public func state(of scope: LockedUseScope) -> LockedUseSessionState {
        lockedUseSessionState(readSession(), for: scope)
    }

    public func requestUnlock(_ scope: LockedUseScope) throws {
        guard verifiedInstallation else { throw LockedUseRuntimeError.driverUnavailable }
        guard state(of: scope) == .locked else { throw LockedUseRuntimeError.notLocked }
        let attempt = scope.attemptID
        binding.open(attempt: attempt, now: now())
        unlock.requestUnlock(attempt: attempt) { [weak self] status in
            Task { @MainActor [weak self] in
                guard let self else { return }
                binding.close(attempt: attempt)
                if status != errAuthorizationSuccess { events(.unlockRequestFailed(attemptID: attempt, status: status)) }
            }
        }
    }

    /// Display sleep through an out-of-process tool: it needs no input synthesis and no
    /// live event tap. The independent guardian issues the same request if this process dies.
    public func requestRelock(_ scope: LockedUseScope) {
        let at = now()
        if let lastRelock, lastRelock.attempt == scope.attemptID, at >= lastRelock.at, at - lastRelock.at < Self.relockSpacing { return }
        guard !relockInFlight else { return }
        lastRelock = (scope.attemptID, at)
        relockInFlight = true
        let lock = lock
        let attempt = scope.attemptID
        lockQueue.async { [weak self] in
            let failed = (try? lock.requestLock()) == nil
            Task { @MainActor [weak self] in
                guard let self else { return }
                relockInFlight = false
                if failed { events(.relockRequestFailed(attemptID: attempt)) }
            }
        }
    }

    /// The trusted-turn bridge: the scope comes from the daemon's approved turn, and the
    /// opaque engine transaction must claim this driver's own pending unlock request.
    public func binds(_ request: LockedUsePluginRequest, to scope: LockedUseScope) -> Bool {
        guard request.attempt == scope.attemptID, state(of: scope) == .locked else { return false }
        return binding.claim(request, attempt: scope.attemptID, now: now())
    }
}
