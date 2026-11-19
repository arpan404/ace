import Foundation
import Security
import LockedUseCore
import LockedUseIPC
import LockedUseRuntime
import LockedUseSession
import LockedUseSystem

final class LockCounter: LockedUseLockSink, @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var fails = false
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    func requestLock() throws {
        lock.lock(); value += 1; lock.unlock()
        if fails { throw LockedUseLockError.failed(1) }
    }
}

/// Records unlock requests; never changes the session by itself.
final class UnlockRecorder: LockedUseUnlockRequesting, @unchecked Sendable {
    var attempts: [String] = []
    var status: OSStatus = errAuthorizationSuccess
    var during: ((String) -> Void)?
    func requestUnlock(attempt: String, completion: @escaping @Sendable (OSStatus) -> Void) {
        attempts.append(attempt)
        during?(attempt)
        completion(status)
    }
}

@MainActor final class SessionDesktop: LockedUseDesktop {
    let topology = try! LockedUseDisplays(ids: [1], generation: 1)
    var covered = false
    func displays() throws -> LockedUseDisplays { topology }
    func prepare(_ scope: LockedUseScope) throws { covered = true }
    func protection() throws -> LockedUseProtection {
        LockedUseProtection(displays: topology, inputGuardReady: covered, relockGuardReady: true)
    }
    func showWorking() {}
    func showRelocking() {}
    func removeAfterConfirmedLock() { covered = false }
}

@MainActor final class SessionGuardian: LockedUseGuardian {
    var armed = false
    func arm(_ scope: LockedUseScope) throws { armed = true }
    func heartbeat(_ scope: LockedUseScope) throws {}
    func ready(_ scope: LockedUseScope) -> Bool { armed }
    func disarmAfterConfirmedLock(_ scope: LockedUseScope) { armed = false }
}

@MainActor final class DriverFixture {
    var facts: LockedUseSessionFacts? = DriverFixture.facts(locked: true)
    var installation = LockedUseInstallationFacts(pluginSigned: true, ruleReachesMechanism: true, lockOnDisplaySleep: true,
                                                  brokerLinked: true, guardianLinked: true)
    var time: UInt64 = 1_000_000_000
    var events: [LockedUseDriverEvent] = []
    var completions: [LockedUseCompletion] = []
    var pulse: (@MainActor () -> Void)?
    let unlock = UnlockRecorder()
    let lock = LockCounter()
    let lockQueue = DispatchQueue(label: "test.relock")
    let desktop = SessionDesktop()
    let guardian = SessionGuardian()
    lazy var driver = LockedUseSystemSessionDriver(readSession: { [unowned self] in facts },
        installation: { [unowned self] in installation }, unlock: unlock, lock: lock,
        now: { [unowned self] in time }, lockQueue: lockQueue, events: { [unowned self] in events.append($0) })
    lazy var coordinator = LockedUseCoordinator(desktop: desktop, driver: driver, guardian: guardian,
        now: { [unowned self] in time }, schedule: { [unowned self] pulse in
            self.pulse = pulse
            return { [weak self] in self?.pulse = nil }
        })
    lazy var observer: LockedUseSessionObserver = {
        let observer = LockedUseSessionObserver(read: { [unowned self] in facts })
        observer.onScopeState = { [unowned self] scope, state in
            if state == .unlocked { coordinator.unlocked(scope) }
            if state == .locked { coordinator.locked(scope) }
        }
        return observer
    }()

    static func facts(locked: Bool?, user: UInt32 = 501, session: UInt32 = 100_003) -> LockedUseSessionFacts {
        LockedUseSessionFacts(onConsole: true, loginDone: true, screenLocked: locked, userID: user, sessionID: session)
    }

    func scope(_ attempt: String = "attempt-1") -> LockedUseScope {
        try! LockedUseScope(userID: 501, sessionID: 100_003, threadID: "thread", turnID: "turn", attemptID: attempt)
    }

    func request(_ attempt: String = "attempt-1", transaction: UInt8 = 7) -> LockedUsePluginRequest {
        LockedUsePluginRequest(attempt: attempt, transaction: Data(repeating: transaction, count: 8),
            requestID: UUID(), deadline: time + 500_000_000)
    }

    /// Starts an attempt whose unlock request reaches the plug-in path while it is pending.
    func begin(work: @escaping @MainActor () async throws -> Void = {}) throws {
        try coordinator.enable()
        observer.watch(scope())
        try coordinator.begin(scope(), work: work) { [unowned self] in completions.append($0) }
    }

    func setSession(locked: Bool) {
        facts = Self.facts(locked: locked ? true : nil)
        observer.poll()
    }

    func flushRelock() { lockQueue.sync {} }

    func settle() async { for _ in 0..<40 { await Task.yield() } }
}
