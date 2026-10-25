import Foundation

/// Pure authorization state. The serial I/O owner supplies continuous monotonic nanoseconds, including sleep, validates
/// peer identities and executes effects. No effect is permission to bypass a missing driver.
public struct LockedUseAuthority {
    public private(set) var phase: LockedUsePhase = .disabled
    public private(set) var scope: LockedUseScope?
    private var displays: LockedUseDisplays?
    private var heartbeatAt: UInt64?
    private var lastTime: UInt64?
    private var clockRevoked = false
    private var deadline: UInt64?
    private var usedRequests = Set<String>()
    private var usedAttempts = Set<String>()
    private var takeover = false
    private var enabled = false
    private var pendingDisable = false
    private var revocation: LockedUseStopReason?
    private var lastManualUnlock: UInt64 = 0
    private var requiredUnlockAfter: UInt64 = 0

    public init() {}

    /// Only the person's settings action may enable this. The caller must first verify
    /// installation and both unlock/relock drivers. This method itself changes no OS policy.
    public mutating func enable() throws {
        guard phase == .disabled else { throw LockedUseError.notReady }
        enabled = true
        phase = takeover ? .manualUnlockRequired : .ready
    }

    public mutating func begin(_ requested: LockedUseScope, displays: LockedUseDisplays, now: UInt64) throws -> [LockedUseEffect] {
        guard !takeover else { throw LockedUseError.takeoverPending }
        guard enabled, phase == .ready else { throw LockedUseError.notReady }
        guard !clockRevoked, lastTime.map({ now >= $0 }) ?? true else { throw LockedUseError.clockWentBackwards }
        guard !usedAttempts.contains(requested.attemptID), usedAttempts.count < 4096 else { throw LockedUseError.staleAttempt }
        lastTime = now
        usedAttempts.insert(requested.attemptID)
        scope = requested
        self.displays = displays
        heartbeatAt = nil
        deadline = adding(2_000_000_000, to: now)
        usedRequests.removeAll()
        revocation = nil
        phase = .covering
        return [.coverDisplays(requested)]
    }

    public mutating func protected(_ attempt: String, facts: LockedUseProtection, now: UInt64) throws -> [LockedUseEffect] {
        guard let scope, scope.attemptID == attempt, phase == .covering else { throw LockedUseError.staleAttempt }
        guard monotonic(now), let deadline, now < deadline, facts.ready, displays == facts.displays else {
            return stop(.protectionLost)
        }
        heartbeatAt = now
        self.deadline = adding(1_000_000_000, to: now)
        phase = .authorizing
        return [.requestUnlock(scope)]
    }

    /// Called exclusively for the authenticated OS authorization mechanism, once per attempt.
    /// An expired, repeated, foreign-session or unprotected request always denies.
    public mutating func authorize(attemptID: String, sessionID: UInt32, requestID: String, facts: LockedUseProtection, now: UInt64) -> Bool {
        guard phase == .authorizing, let scope, scope.attemptID == attemptID, scope.sessionID == sessionID,
              !requestID.isEmpty, requestID.utf8.count <= 256, !usedRequests.contains(requestID),
              revocation == nil, monotonic(now) else { return false }
        guard let deadline, now < deadline else { revocation = .expired; return false }
        guard facts.ready, facts.displays == displays, freshProtection(now) else { revocation = .protectionLost; return false }
        usedRequests.insert(requestID)
        phase = .unlocking
        self.deadline = adding(1_000_000_000, to: now)
        return true
    }

    /// A separate authenticated OS observer must confirm the desktop actually unlocked.
    public mutating func unlocked(_ attempt: String, sessionID: UInt32, facts: LockedUseProtection, now: UInt64) throws -> [LockedUseEffect] {
        guard let scope, scope.attemptID == attempt, phase == .unlocking else { throw LockedUseError.staleAttempt }
        guard monotonic(now), let deadline, now < deadline, scope.sessionID == sessionID,
              facts.ready, facts.displays == displays, freshProtection(now) else { return stop(.protectionLost) }
        heartbeatAt = now
        phase = .working
        self.deadline = adding(60_000_000_000, to: now)
        return [.runApprovedWork(scope)]
    }

    public mutating func heartbeat(_ attempt: String, facts: LockedUseProtection, now: UInt64) throws -> [LockedUseEffect] {
        guard let scope, scope.attemptID == attempt, [.authorizing, .unlocking, .working].contains(phase) else {
            throw LockedUseError.staleAttempt
        }
        guard monotonic(now), freshProtection(now), let deadline, now < deadline, facts.ready, facts.displays == displays else {
            return stop(.protectionLost)
        }
        heartbeatAt = now
        return []
    }

    /// Local input latches takeover even before the unlock transaction finishes.
    public mutating func localInput(manualUnlockGeneration: UInt64) -> [LockedUseEffect] {
        guard scope != nil else { return [] }
        takeover = true
        requiredUnlockAfter = max(lastManualUnlock, manualUnlockGeneration)
        return stop(.localInput)
    }

    public mutating func end(_ attempt: String, reason: LockedUseStopReason) throws -> [LockedUseEffect] {
        guard scope?.attemptID == attempt else { throw LockedUseError.staleAttempt }
        return stop(reason)
    }

    public mutating func disable() -> [LockedUseEffect] {
        enabled = false
        pendingDisable = scope != nil
        if scope != nil { return stop(.disabled) }
        phase = .disabled
        return []
    }

    /// Never remove covers just because a timer or a tool says work finished.
    public mutating func locked(_ attempt: String, sessionID: UInt32) throws -> [LockedUseEffect] {
        guard let scope, scope.attemptID == attempt, scope.sessionID == sessionID, [.relocking, .faulted].contains(phase) else {
            throw LockedUseError.staleAttempt
        }
        let result: [LockedUseEffect] = [.removeCovers(scope)]
        self.scope = nil
        displays = nil
        heartbeatAt = nil
        deadline = nil
        if pendingDisable { phase = .disabled; pendingDisable = false }
        else { phase = takeover ? .manualUnlockRequired : .ready }
        return result
    }

    /// A trusted observer owns this generation. Agent callbacks cannot clear takeover.
    public mutating func manualUnlockObserved(generation: UInt64) {
        guard [.manualUnlockRequired, .disabled].contains(phase), generation > lastManualUnlock else { return }
        lastManualUnlock = generation
        guard generation > requiredUnlockAfter else { return }
        takeover = false
        if phase == .manualUnlockRequired { phase = enabled ? .ready : .disabled }
    }

    public mutating func tick(now: UInt64) -> [LockedUseEffect] {
        guard let scope else { return [] }
        if !monotonic(now) {
            if [.relocking, .faulted].contains(phase) { phase = .faulted; return [.relock(scope)] }
            return stop(.clockChanged)
        }
        if let revocation { return stop(revocation) }
        if phase == .relocking {
            if let deadline, now >= deadline {
                // Retain covers and keep asking the independent relock owner. Never declare
                // the machine secured, or return to ready, without lock confirmation.
                phase = .faulted
                return [.relock(scope)]
            }
            return []
        }
        if phase == .faulted { return [.relock(scope)] }
        if let deadline, now >= deadline { return stop(.expired) }
        if [.authorizing, .unlocking, .working].contains(phase), !freshProtection(now) { return stop(.protectionLost) }
        return []
    }

    private mutating func stop(_ reason: LockedUseStopReason) -> [LockedUseEffect] {
        guard let scope else { return [] }
        if phase == .relocking || phase == .faulted { return [] }
        phase = .relocking
        revocation = nil
        deadline = lastTime.map { adding(2_000_000_000, to: $0) }
        heartbeatAt = nil
        return [.stopWork(scope, reason), .relock(scope)]
    }

    private mutating func monotonic(_ now: UInt64) -> Bool {
        guard !clockRevoked else { return false }
        guard lastTime.map({ now >= $0 }) ?? true else { clockRevoked = true; return false }
        lastTime = now
        return true
    }

    private func freshProtection(_ now: UInt64) -> Bool {
        guard let heartbeatAt, now >= heartbeatAt else { return false }
        return now - heartbeatAt < 500_000_000
    }

    private func adding(_ delta: UInt64, to value: UInt64) -> UInt64 {
        let (sum, overflow) = value.addingReportingOverflow(delta)
        return overflow ? UInt64.max : sum
    }
}
