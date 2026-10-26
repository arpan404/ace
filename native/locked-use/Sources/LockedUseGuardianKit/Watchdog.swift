/// Why the guardian requested a relock on its own.
public enum LockedUseGuardianTrip: String, Equatable, Sendable {
    case heartbeatLost, linkDropped, ownerExited, clockWentBackwards
}

public enum LockedUseGuardianError: Error, Equatable { case busy, invalidScope, wrongUser, notArmed }

/// Pure relock watchdog. Once armed for an attempt, it requests a relock when heartbeats
/// stop, the owner's link drops or the owner process exits. It needs nothing further
/// from the owner to do so. Time is continuous monotonic nanoseconds, including sleep.
public struct LockedUseWatchdog: Equatable, Sendable {
    /// The coordinator heartbeats at least every 100 ms.
    public static let heartbeatTimeout: UInt64 = 1_000_000_000
    /// After tripping, the relock is repeated a few times in case the first request is lost,
    /// then stops so it never fights a person who unlocks manually afterwards.
    public static let retrySpacing: UInt64 = 2_000_000_000
    public static let retries = 3

    public enum State: Equatable, Sendable {
        case idle
        case armed(attempt: String, owner: Int32, heartbeatAt: UInt64)
        case tripped(attempt: String, reason: LockedUseGuardianTrip, nextAt: UInt64, remaining: Int)
    }

    public private(set) var state: State = .idle
    private var lastTime: UInt64 = 0

    public init() {}

    public var armedAttempt: String? {
        if case .armed(let attempt, _, _) = state { return attempt }
        return nil
    }

    public mutating func arm(attempt: String, owner: Int32, now: UInt64) throws -> LockedUseGuardianTrip? {
        if let trip = advance(now) { return trip }
        guard owner > 0, !attempt.isEmpty else { throw LockedUseGuardianError.invalidScope }
        if case .armed(let current, let holder, _) = state, current != attempt || holder != owner {
            throw LockedUseGuardianError.busy
        }
        state = .armed(attempt: attempt, owner: owner, heartbeatAt: now)
        return nil
    }

    /// Returns false if not armed for this owner and attempt; the owner must treat that as lost readiness.
    public mutating func heartbeat(attempt: String, owner: Int32, now: UInt64) -> (alive: Bool, trip: LockedUseGuardianTrip?) {
        if let trip = advance(now) { return (false, trip) }
        guard case .armed(let current, let holder, _) = state, current == attempt, holder == owner else { return (false, nil) }
        state = .armed(attempt: attempt, owner: owner, heartbeatAt: now)
        return (true, nil)
    }

    /// The owner disarms only after it has observed a confirmed OS lock.
    public mutating func disarm(attempt: String, owner: Int32) -> Bool {
        guard case .armed(let current, let holder, _) = state, current == attempt, holder == owner else { return false }
        state = .idle
        return true
    }

    public mutating func linkDropped(owner: Int32, now: UInt64) -> LockedUseGuardianTrip? {
        if let trip = advance(now) { return trip }
        return trip(owner: owner, .linkDropped, now: now)
    }

    public mutating func ownerExited(_ pid: Int32, now: UInt64) -> LockedUseGuardianTrip? {
        if let trip = advance(now) { return trip }
        return trip(owner: pid, .ownerExited, now: now)
    }

    /// Returns a trip reason whenever a relock request must be issued now.
    public mutating func tick(now: UInt64) -> LockedUseGuardianTrip? { advance(now) }

    private mutating func advance(_ now: UInt64) -> LockedUseGuardianTrip? {
        guard now >= lastTime else {
            lastTime = now
            if case .idle = state { return nil }
            let attempt = armedAttempt ?? trippedAttempt ?? ""
            state = .tripped(attempt: attempt, reason: .clockWentBackwards, nextAt: now &+ Self.retrySpacing, remaining: Self.retries)
            return .clockWentBackwards
        }
        lastTime = now
        switch state {
        case .idle:
            return nil
        case .armed(let attempt, _, let heartbeatAt):
            guard now - heartbeatAt >= Self.heartbeatTimeout else { return nil }
            state = .tripped(attempt: attempt, reason: .heartbeatLost, nextAt: now &+ Self.retrySpacing, remaining: Self.retries)
            return .heartbeatLost
        case .tripped(let attempt, let reason, let nextAt, let remaining):
            guard remaining > 0, now >= nextAt else { return nil }
            state = .tripped(attempt: attempt, reason: reason, nextAt: now &+ Self.retrySpacing, remaining: remaining - 1)
            return reason
        }
    }

    private mutating func trip(owner: Int32, _ reason: LockedUseGuardianTrip, now: UInt64) -> LockedUseGuardianTrip? {
        guard case .armed(let attempt, let holder, _) = state, holder == owner else { return nil }
        state = .tripped(attempt: attempt, reason: reason, nextAt: now &+ Self.retrySpacing, remaining: Self.retries)
        return reason
    }

    private var trippedAttempt: String? {
        if case .tripped(let attempt, _, _, _) = state { return attempt }
        return nil
    }
}
