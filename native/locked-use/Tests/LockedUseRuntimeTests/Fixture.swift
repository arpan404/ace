import Foundation
import LockedUseCore
import LockedUseIPC
import LockedUseRuntime

@MainActor final class Desktop: LockedUseDesktop {
    let topology = try! LockedUseDisplays(ids: [1, 2], generation: 1)
    var covered = false
    var inputReady = true
    var orderingVerified = true
    var onWorking: (() -> Void)?
    func displays() throws -> LockedUseDisplays { topology }
    func prepare(_ scope: LockedUseScope) throws { covered = true }
    func protection() throws -> LockedUseProtection {
        LockedUseProtection(displays: topology, inputGuardReady: inputReady && covered && orderingVerified, relockGuardReady: true)
    }
    func showWorking() { onWorking?() }
    func showRelocking() {}
    func removeAfterConfirmedLock() { covered = false }
}

@MainActor final class Driver: LockedUseSessionDriver {
    var verifiedInstallation = true
    var locked = true
    var sessionAvailable = true
    var transactionMatches = true
    var onUnlock: ((LockedUseScope) -> Void)?
    var onRelock: ((LockedUseScope) -> Void)?
    func state(of scope: LockedUseScope) -> LockedUseSessionState { sessionAvailable ? (locked ? .locked : .unlocked) : .unavailable }
    func requestUnlock(_ scope: LockedUseScope) throws { onUnlock?(scope) }
    func requestRelock(_ scope: LockedUseScope) { onRelock?(scope) }
    func binds(_ request: LockedUsePluginRequest, to scope: LockedUseScope) -> Bool { transactionMatches }
}

@MainActor final class Guardian: LockedUseGuardian {
    var live = true
    var armed = false
    var onArm: (() -> Void)?
    func arm(_ scope: LockedUseScope) throws { armed = true; onArm?() }
    func heartbeat(_ scope: LockedUseScope) throws {}
    func ready(_ scope: LockedUseScope) -> Bool { live && armed }
    func disarmAfterConfirmedLock(_ scope: LockedUseScope) { armed = false }
}

@MainActor final class Fixture {
    let desktop = Desktop()
    let driver = Driver()
    let guardian = Guardian()
    var time: UInt64 = 1_000_000_000
    var pulse: (@MainActor () -> Void)?
    var completions: [LockedUseCompletion] = []
    lazy var runtime = LockedUseCoordinator(desktop: desktop, driver: driver, guardian: guardian,
        now: { [unowned self] in time }, schedule: { [unowned self] pulse in
            self.pulse = pulse
            return { [weak self] in self?.pulse = nil }
        })

    func scope(_ id: String = "attempt") throws -> LockedUseScope {
        try LockedUseScope(userID: 501, sessionID: 42, threadID: "thread", turnID: "turn", attemptID: id)
    }

    func request(_ id: String = "attempt") -> LockedUsePluginRequest {
        LockedUsePluginRequest(attempt: id, transaction: Data(repeating: 1, count: MemoryLayout<UnsafeRawPointer>.size),
            requestID: UUID(), deadline: time + 500_000_000)
    }

    func begin(work: @escaping @MainActor () async throws -> Void = {}) throws {
        try runtime.enable()
        try runtime.begin(scope(), work: work) { [unowned self] in completions.append($0) }
    }

    func unlock() throws {
        guard runtime.authorize(request()) else { throw LockedUseRuntimeError.driverUnavailable }
        driver.locked = false
        runtime.unlocked(try scope())
    }

    func confirmLock() throws {
        driver.locked = true
        runtime.locked(try scope())
    }

    func settleWork() async {
        for _ in 0..<30 { await Task.yield() }
    }
}
