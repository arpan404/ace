import Foundation
import LockedUseCore
import LockedUseIPC

/// Owns one approved attempt from protection setup through confirmed OS relock.
/// All callbacks are serialized on the main actor. No tool-facing API can supply
/// readiness, identity, an OS lock confirmation, or permission to enable the feature.
@MainActor public final class LockedUseCoordinator {
    public var phase: LockedUsePhase { active != nil && lockConfirmed ? .relocking : authority.phase }
    private var authority = LockedUseAuthority()
    private let desktop: LockedUseDesktop
    private let driver: LockedUseSessionDriver
    private let guardian: LockedUseGuardian
    private let now: () -> UInt64
    private let schedule: (@escaping @MainActor () -> Void) -> () -> Void
    private var stopTimer: (() -> Void)?
    private var active: LockedUseScope?
    private var work: (@MainActor () async throws -> Void)?
    private var task: Task<Void, Never>?
    private var workStopped = true
    private var lockConfirmed = false
    private var reason: LockedUseStopReason?
    private var workError: Error?
    private var completion: ((LockedUseCompletion) -> Void)?

    /// schedule must deliver a recurring heartbeat at most 100 ms apart. Both the
    /// authority and independent guardian enforce deadlines even if it stops firing.
    public init(desktop: LockedUseDesktop, driver: LockedUseSessionDriver, guardian: LockedUseGuardian,
                now: @escaping () -> UInt64,
                schedule: @escaping (@escaping @MainActor () -> Void) -> () -> Void) {
        self.desktop = desktop
        self.driver = driver
        self.guardian = guardian
        self.now = now
        self.schedule = schedule
    }

    /// Called only by the trusted user's opt-in flow after installation verification.
    public func enable() throws {
        guard driver.verifiedInstallation else { throw LockedUseRuntimeError.driverUnavailable }
        try authority.enable()
    }

    public func disable() { apply(authority.disable()) }

    deinit {
        stopTimer?()
        task?.cancel()
        // The independently armed guardian owns relock if this object/process dies.
    }

    /// scope comes from the daemon's approved turn, never from an agent tool argument.
    /// The work closure must honor cancellation and await termination of its subprocesses.
    /// Completion is withheld until the work exits AND the OS confirms relock.
    public func begin(_ scope: LockedUseScope, work: @escaping @MainActor () async throws -> Void,
                      completion: @escaping (LockedUseCompletion) -> Void) throws {
        guard active == nil else { throw LockedUseRuntimeError.busy }
        guard driver.verifiedInstallation else { throw LockedUseRuntimeError.driverUnavailable }
        guard driver.state(of: scope) == .locked else { throw LockedUseRuntimeError.notLocked }
        let effects = try authority.begin(scope, displays: desktop.displays(), now: now())
        active = scope
        self.work = work
        self.completion = completion
        reason = nil
        workError = nil
        workStopped = true
        lockConfirmed = false
        stopTimer = schedule { [weak self] in self?.heartbeat() }
        apply(effects)
    }

    /// Only the authenticated authorization endpoint calls this. The OS driver must
    /// bind the opaque engine transaction before the single-use core permit is consumed.
    public func authorize(_ request: LockedUsePluginRequest) -> Bool {
        guard let scope = active, request.attempt == scope.attemptID,
              request.deadline > now(), driver.verifiedInstallation,
              driver.binds(request, to: scope), let facts = try? protection(scope), request.deadline > now() else { return false }
        return authority.authorize(attemptID: request.attempt, sessionID: scope.sessionID,
            requestID: request.requestID.uuidString, facts: facts, now: now())
    }

    public func unlocked(_ scope: LockedUseScope) {
        guard active == scope, driver.state(of: scope) == .unlocked else { return }
        guard authority.phase == .unlocking else {
            if [.covering, .authorizing].contains(authority.phase) { stop(scope, reason: .sessionChanged) }
            return
        }
        do {
            apply(try authority.unlocked(scope.attemptID, sessionID: scope.sessionID,
                facts: protection(scope), now: now()))
        } catch { stop(scope, reason: .protectionLost) }
    }

    public func locked(_ scope: LockedUseScope) {
        guard active == scope, driver.state(of: scope) == .locked else { return }
        // A spontaneous lock while working is a stop, never permission to keep working.
        if reason == nil { stop(scope, reason: .sessionChanged) }
        guard let effects = try? authority.locked(scope.attemptID, sessionID: scope.sessionID) else { return }
        lockConfirmed = true
        apply(effects)
        finishIfSecured()
    }

    public func cancel(_ scope: LockedUseScope) { stop(scope, reason: .cancelled) }
    public func connectionLost(_ scope: LockedUseScope) { stop(scope, reason: .connectionLost) }
    public func protectionLost(_ scope: LockedUseScope) { stop(scope, reason: .protectionLost) }

    public func localInput(_ scope: LockedUseScope, manualUnlockGeneration: UInt64) {
        guard active == scope else { return }
        apply(authority.localInput(manualUnlockGeneration: manualUnlockGeneration))
    }

    public func manualUnlockObserved(generation: UInt64) {
        guard active == nil else { return }
        authority.manualUnlockObserved(generation: generation)
    }

    private func protection(_ scope: LockedUseScope) throws -> LockedUseProtection {
        guard driver.verifiedInstallation else { throw LockedUseRuntimeError.driverUnavailable }
        let facts = try desktop.protection()
        return LockedUseProtection(displays: facts.displays, inputGuardReady: facts.inputGuardReady,
            relockGuardReady: facts.relockGuardReady && guardian.ready(scope))
    }

    private func heartbeat() {
        guard let scope = active else { return }
        apply(authority.tick(now: now()))
        guard active == scope, reason == nil else { return }
        guard driver.verifiedInstallation, driver.state(of: scope) != .unavailable else {
            stop(scope, reason: .sessionChanged)
            return
        }
        if authority.phase == .working, driver.state(of: scope) != .unlocked {
            stop(scope, reason: .sessionChanged)
            return
        }
        do {
            try guardian.heartbeat(scope)
            if [.authorizing, .unlocking, .working].contains(authority.phase) {
                apply(try authority.heartbeat(scope.attemptID, facts: protection(scope), now: now()))
            }
        } catch { stop(scope, reason: .protectionLost) }
    }

    private func stop(_ scope: LockedUseScope, reason: LockedUseStopReason) {
        guard active == scope, let effects = try? authority.end(scope.attemptID, reason: reason) else { return }
        apply(effects)
    }

    private func apply(_ effects: [LockedUseEffect]) {
        for effect in effects {
            switch effect {
            case .coverDisplays(let scope):
                guard active == scope else { continue }
                do {
                    try guardian.arm(scope)
                    guard active == scope, authority.phase == .covering else { continue }
                    try desktop.prepare(scope)
                    guard active == scope, authority.phase == .covering else { continue }
                    apply(try authority.protected(scope.attemptID, facts: protection(scope), now: now()))
                } catch { stop(scope, reason: .protectionLost) }
            case .requestUnlock(let scope):
                guard active == scope, reason == nil else { continue }
                do { try driver.requestUnlock(scope) }
                catch { stop(scope, reason: .protectionLost) }
            case .runApprovedWork(let scope):
                guard active == scope, reason == nil, let work, task == nil else { continue }
                desktop.showWorking()
                guard active == scope, reason == nil else { continue }
                workStopped = false
                task = Task { [weak self] in
                    do { try Task.checkCancellation(); try await work() }
                    catch { self?.workError = error }
                    guard let self, active == scope else { return }
                    workStopped = true
                    task = nil
                    stop(scope, reason: workError == nil ? .finished : .workFailed)
                    finishIfSecured()
                }
            case .stopWork(let scope, let why):
                guard active == scope else { continue }
                reason = why
                work = nil
                task?.cancel()
                desktop.showRelocking()
            case .relock(let scope):
                guard active == scope else { continue }
                driver.requestRelock(scope)
            case .removeCovers(let scope):
                guard active == scope, lockConfirmed else { continue }
                desktop.removeAfterConfirmedLock()
            }
        }
    }

    private func finishIfSecured() {
        guard let scope = active, let reason, lockConfirmed, workStopped else { return }
        guardian.disarmAfterConfirmedLock(scope)
        stopTimer?()
        stopTimer = nil
        let notify = completion
        let result = LockedUseCompletion(scope: scope, reason: reason, workError: workError)
        active = nil
        work = nil
        completion = nil
        notify?(result)
    }
}
