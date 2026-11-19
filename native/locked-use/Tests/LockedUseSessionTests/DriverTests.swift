import XCTest
import Security
import LockedUseCore
import LockedUseIPC
import LockedUseRuntime
import LockedUseSession
import LockedUseSystem

final class DriverTests: XCTestCase {
    @MainActor func testASuccessfulUnlockRequestIsNotTreatedAsAnUnlockedDesktop() async throws {
        let f = DriverFixture()
        var ran = false
        try f.begin { ran = true }
        XCTAssertEqual(f.unlock.attempts, ["attempt-1"])
        XCTAssertTrue(f.coordinator.authorize(f.request()))
        await f.settle()
        f.observer.poll()
        f.pulse?()
        await f.settle()
        XCTAssertEqual(f.driver.state(of: f.scope()), .locked)
        XCTAssertFalse(ran, "Authorization success alone must never start approved work")
        f.setSession(locked: false)
        await f.settle()
        XCTAssertTrue(ran)
    }

    @MainActor func testUnlockedReadingsForAnotherSessionOrMalformedFlagsAreUnavailable() {
        let f = DriverFixture()
        f.facts = DriverFixture.facts(locked: nil, session: 999)
        XCTAssertEqual(f.driver.state(of: f.scope()), .unavailable)
        f.facts = DriverFixture.facts(locked: nil, user: 502)
        XCTAssertEqual(f.driver.state(of: f.scope()), .unavailable)
        f.facts = LockedUseSessionFacts(onConsole: true, loginDone: true, screenLocked: nil, lockFlagMalformed: true,
                                        userID: 501, sessionID: 100_003)
        XCTAssertEqual(f.driver.state(of: f.scope()), .unavailable)
        f.facts = LockedUseSessionFacts(onConsole: false, loginDone: true, screenLocked: nil, userID: 501, sessionID: 100_003)
        XCTAssertEqual(f.driver.state(of: f.scope()), .unavailable)
        f.facts = nil
        XCTAssertEqual(f.driver.state(of: f.scope()), .unavailable)
    }

    @MainActor func testWorkNeverStartsWhenTheSessionReadsUnavailableAfterTheGrant() async throws {
        let f = DriverFixture()
        var ran = false
        try f.begin { ran = true }
        XCTAssertTrue(f.coordinator.authorize(f.request()))
        f.facts = nil
        f.observer.poll()
        f.coordinator.unlocked(f.scope())
        f.pulse?()
        await f.settle()
        XCTAssertFalse(ran)
        XCTAssertTrue(f.desktop.covered)
        f.flushRelock()
        XCTAssertGreaterThan(f.lock.count, 0)
    }

    @MainActor func testAnyMissingInstallationFactKeepsTheFeatureDisabled() {
        let keys: [WritableKeyPath<LockedUseInstallationFacts, Bool>] = [\.pluginSigned, \.ruleReachesMechanism,
            \.lockOnDisplaySleep, \.brokerLinked, \.guardianLinked]
        for key in keys {
            let f = DriverFixture()
            f.installation[keyPath: key] = false
            XCTAssertFalse(f.driver.verifiedInstallation)
            XCTAssertThrowsError(try f.coordinator.enable())
            XCTAssertThrowsError(try f.driver.requestUnlock(f.scope()))
            XCTAssertTrue(f.unlock.attempts.isEmpty)
        }
    }

    @MainActor func testOnlyThePendingRequestsFirstTransactionIsBound() throws {
        let f = DriverFixture()
        XCTAssertFalse(f.driver.binds(f.request(), to: f.scope()), "No unlock request was issued")
        f.unlock.during = { _ in
            MainActor.assumeIsolated {
                XCTAssertFalse(f.driver.binds(f.request("other"), to: f.scope()))
                XCTAssertTrue(f.driver.binds(f.request(transaction: 1), to: f.scope()))
                XCTAssertFalse(f.driver.binds(f.request(transaction: 2), to: f.scope()), "A second transaction cannot rebind")
                XCTAssertTrue(f.driver.binds(f.request(transaction: 1), to: f.scope()))
                f.time += LockedUseUnlockBinding.window
                XCTAssertFalse(f.driver.binds(f.request(transaction: 1), to: f.scope()), "The pending window expired")
            }
        }
        try f.driver.requestUnlock(f.scope())
    }

    @MainActor func testBindingRequiresTheApprovedSessionToStillBeLocked() throws {
        let f = DriverFixture()
        f.unlock.during = { _ in
            MainActor.assumeIsolated {
                f.facts = DriverFixture.facts(locked: nil)
                XCTAssertFalse(f.driver.binds(f.request(), to: f.scope()))
            }
        }
        try f.driver.requestUnlock(f.scope())
        f.facts = DriverFixture.facts(locked: nil)
        XCTAssertThrowsError(try f.driver.requestUnlock(f.scope("attempt-2")), "An unlocked session is never an unlock target")
    }

    @MainActor func testAFailedUnlockRequestIsReportedAndTheAttemptStillRelocks() async throws {
        let f = DriverFixture()
        f.unlock.status = errAuthorizationDenied
        try f.begin()
        await f.settle()
        XCTAssertEqual(f.events, [.unlockRequestFailed(attemptID: "attempt-1", status: errAuthorizationDenied)])
        f.time += 2_000_000_000
        f.pulse?()
        f.flushRelock()
        XCTAssertGreaterThan(f.lock.count, 0)
        XCTAssertTrue(f.desktop.covered)
    }

    @MainActor func testRelockIsRequestedOnEveryStopPath() async throws {
        let stops: [(String, @MainActor (DriverFixture) -> Void)] = [
            ("cancel", { $0.coordinator.cancel($0.scope()) }),
            ("connection lost", { $0.coordinator.connectionLost($0.scope()) }),
            ("protection lost", { $0.coordinator.protectionLost($0.scope()) }),
            ("local input", { $0.coordinator.localInput($0.scope(), manualUnlockGeneration: 0) }),
            ("session unavailable", { $0.facts = nil; $0.pulse?() }),
            ("spontaneous lock", { $0.setSession(locked: true) }),
            ("expiry", { $0.time += 61_000_000_000; $0.pulse?() }),
            ("disable", { $0.coordinator.disable() }),
        ]
        for (name, stop) in stops {
            let f = DriverFixture()
            var resume: CheckedContinuation<Void, Never>?
            try f.begin { await withCheckedContinuation { resume = $0 } }
            XCTAssertTrue(f.coordinator.authorize(f.request()))
            f.setSession(locked: false)
            await f.settle()
            XCTAssertEqual(f.coordinator.phase, .working, name)
            stop(f)
            f.flushRelock()
            XCTAssertEqual(f.lock.count, 1, "\(name) must request an OS relock")
            // A spontaneous lock is itself the confirmed OS lock, so only it may drop covers here.
            XCTAssertEqual(f.desktop.covered, name != "spontaneous lock", "\(name) must keep covers until a confirmed lock")
            resume?.resume()
            await f.settle()
            f.setSession(locked: true)
            XCTAssertFalse(f.desktop.covered, name)
        }
    }

    @MainActor func testFinishedAndFailedWorkBothRelockBeforeCompleting() async throws {
        for fails in [false, true] {
            let f = DriverFixture()
            try f.begin { if fails { throw CocoaError(.fileNoSuchFile) } }
            XCTAssertTrue(f.coordinator.authorize(f.request()))
            f.setSession(locked: false)
            await f.settle()
            f.flushRelock()
            XCTAssertEqual(f.lock.count, 1)
            XCTAssertTrue(f.completions.isEmpty, "Completion waits for the OS to confirm the lock")
            f.setSession(locked: true)
            XCTAssertEqual(f.completions.first?.reason, fails ? .workFailed : .finished)
        }
    }

    @MainActor func testFaultedRelockKeepsRetryingWithoutFloodingTheOS() async throws {
        let f = DriverFixture()
        f.lock.fails = true
        try f.begin()
        f.coordinator.cancel(f.scope())
        f.flushRelock()
        await f.settle()
        XCTAssertEqual(f.events.last, .relockRequestFailed(attemptID: "attempt-1"))
        for _ in 0..<10 { f.time += 50_000_000; f.pulse?(); f.flushRelock(); await f.settle() }
        f.time += 2_000_000_000
        for _ in 0..<10 { f.time += 50_000_000; f.pulse?(); f.flushRelock(); await f.settle() }
        XCTAssertEqual(f.coordinator.phase, .faulted)
        XCTAssertGreaterThan(f.lock.count, 1, "A faulted relock is retried")
        XCTAssertLessThanOrEqual(f.lock.count, 4, "Retries are spaced at least a second apart")
        XCTAssertTrue(f.desktop.covered)
    }

    @MainActor func testManualUnlockGenerationOnlyAdvancesBetweenAttempts() {
        let f = DriverFixture()
        var generations: [UInt64] = []
        f.observer.onManualUnlock = { generations.append($0) }
        f.setSession(locked: true)
        f.setSession(locked: false)
        XCTAssertEqual(generations, [1])
        f.setSession(locked: true)
        f.observer.watch(f.scope())
        f.setSession(locked: false)
        XCTAssertEqual(generations, [1], "An automated unlock during an attempt is not a manual unlock")
    }
}
