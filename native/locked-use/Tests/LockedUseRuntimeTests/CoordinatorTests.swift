import XCTest
import LockedUseCore
import LockedUseRuntime

final class CoordinatorTests: XCTestCase {
    @MainActor func testWorkWaitsForRealUnlockAndCompletionWaitsForRealRelock() async throws {
        let f = Fixture()
        var ran = false
        try f.begin { ran = true }
        await f.settleWork()
        XCTAssertFalse(ran)
        XCTAssertTrue(f.desktop.covered)
        XCTAssertTrue(f.runtime.authorize(f.request()))
        await f.settleWork()
        XCTAssertFalse(ran, "An authorization grant alone is not an OS unlock")
        f.driver.locked = false
        f.runtime.unlocked(try f.scope())
        await f.settleWork()
        XCTAssertTrue(ran)
        XCTAssertTrue(f.completions.isEmpty)
        XCTAssertTrue(f.desktop.covered)
        XCTAssertTrue(f.guardian.armed)
        try f.confirmLock()
        XCTAssertEqual(f.completions.first?.reason, .finished)
        XCTAssertFalse(f.desktop.covered)
        XCTAssertFalse(f.guardian.armed)
    }

    @MainActor func testMissingDriverCannotBeEnabledOrBeginWork() throws {
        let f = Fixture()
        f.driver.verifiedInstallation = false
        XCTAssertThrowsError(try f.runtime.enable())
        XCTAssertThrowsError(try f.runtime.begin(f.scope(), work: {}) { _ in XCTFail("Unexpected completion") })
        XCTAssertFalse(f.desktop.covered)
    }

    @MainActor func testAnUnboundOSTransactionCannotStartApprovedWork() async throws {
        let f = Fixture()
        var ran = false
        try f.begin { ran = true }
        f.driver.transactionMatches = false
        XCTAssertFalse(f.runtime.authorize(f.request()))
        f.driver.locked = false
        f.runtime.unlocked(try f.scope())
        await f.settleWork()
        XCTAssertFalse(ran)
        XCTAssertTrue(f.desktop.covered)
    }

    @MainActor func testCancellationBeforeAuthorizationMakesEveryLateGrantFail() throws {
        let f = Fixture()
        try f.begin()
        f.runtime.cancel(try f.scope())
        XCTAssertFalse(f.runtime.authorize(f.request()))
        XCTAssertTrue(f.completions.isEmpty)
        try f.confirmLock()
        XCTAssertEqual(f.completions.first?.reason, .cancelled)
    }

    @MainActor func testDeadGuardianAndUnverifiedWindowOrderingPreventAuthorization() throws {
        for loseGuardian in [true, false] {
            let f = Fixture()
            try f.begin()
            if loseGuardian { f.guardian.live = false }
            else { f.desktop.orderingVerified = false }
            XCTAssertFalse(f.runtime.authorize(f.request()))
            f.pulse?()
            XCTAssertEqual(f.runtime.phase, .relocking)
            XCTAssertTrue(f.desktop.covered)
        }
    }

    @MainActor func testACancelledTaskMustActuallyExitBeforeTheTurnCanComplete() async throws {
        let f = Fixture()
        var resume: CheckedContinuation<Void, Never>?
        try f.begin { await withCheckedContinuation { resume = $0 } }
        try f.unlock()
        await f.settleWork()
        XCTAssertNotNil(resume)
        f.runtime.connectionLost(try f.scope())
        try f.confirmLock()
        XCTAssertTrue(f.completions.isEmpty, "A cancellation request is not stopped work")
        XCTAssertTrue(f.guardian.armed)
        XCTAssertEqual(f.runtime.phase, .relocking)
        XCTAssertThrowsError(try f.runtime.begin(f.scope("next"), work: {}) { _ in })
        resume?.resume()
        await f.settleWork()
        XCTAssertEqual(f.completions.first?.reason, .connectionLost)
        XCTAssertFalse(f.guardian.armed)
    }

    @MainActor func testTakeoverDuringGuardianSetupCannotContinueToUnlock() throws {
        let f = Fixture()
        var requestedUnlock = false
        f.driver.onUnlock = { _ in requestedUnlock = true }
        f.guardian.onArm = { f.runtime.localInput(try! f.scope(), manualUnlockGeneration: 1) }
        try f.begin()
        XCTAssertFalse(requestedUnlock)
        XCTAssertFalse(f.desktop.covered)
        try f.confirmLock()
        XCTAssertEqual(f.runtime.phase, .manualUnlockRequired)
    }

    @MainActor func testTakeoverWhileShowingWorkingCannotStartTheWorkClosure() async throws {
        let f = Fixture()
        var ran = false
        try f.begin { ran = true }
        f.desktop.onWorking = { f.runtime.localInput(try! f.scope(), manualUnlockGeneration: 1) }
        try f.unlock()
        await f.settleWork()
        XCTAssertFalse(ran)
        XCTAssertTrue(f.desktop.covered)
        try f.confirmLock()
        XCTAssertEqual(f.completions.first?.reason, .localInput)
    }

    @MainActor func testSleepSizedClockJumpRevokesPendingUnlockWithoutRemovingCovers() throws {
        let f = Fixture()
        try f.begin()
        f.time += 30_000_000_000
        f.pulse?()
        XCTAssertFalse(f.runtime.authorize(f.request()))
        XCTAssertTrue(f.desktop.covered)
        XCTAssertTrue(f.completions.isEmpty)
        try f.confirmLock()
        XCTAssertEqual(f.completions.first?.reason, .expired)
    }

    @MainActor func testOldTurnCallbacksCannotStopOrCompleteTheNextTurn() async throws {
        let f = Fixture()
        try f.begin()
        f.runtime.cancel(try f.scope())
        try f.confirmLock()
        let next = try f.scope("next")
        try f.runtime.begin(next, work: {}) { f.completions.append($0) }
        f.runtime.cancel(try f.scope())
        f.runtime.locked(try f.scope())
        f.runtime.unlocked(try f.scope())
        XCTAssertEqual(f.completions.count, 1)
        XCTAssertTrue(f.desktop.covered)
        XCTAssertTrue(f.runtime.authorize(f.request("next")))
    }

    @MainActor func testUnavailableSessionCannotConfirmUnlockOrRemoveTheCovers() async throws {
        let f = Fixture()
        var ran = false
        try f.begin { ran = true }
        XCTAssertTrue(f.runtime.authorize(f.request()))
        f.driver.sessionAvailable = false
        f.runtime.unlocked(try f.scope())
        f.pulse?()
        await f.settleWork()
        XCTAssertFalse(ran)
        XCTAssertTrue(f.desktop.covered)
        f.runtime.locked(try f.scope())
        XCTAssertTrue(f.desktop.covered)
        XCTAssertTrue(f.completions.isEmpty)
        f.driver.sessionAvailable = true
        try f.confirmLock()
        XCTAssertEqual(f.completions.first?.reason, .sessionChanged)
    }

    @MainActor func testWorkErrorsAreReportedAfterConfirmedRelock() async throws {
        let f = Fixture()
        try f.begin { throw CocoaError(.fileNoSuchFile) }
        try f.unlock()
        await f.settleWork()
        XCTAssertTrue(f.completions.isEmpty)
        try f.confirmLock()
        XCTAssertEqual(f.completions.first?.reason, .workFailed)
        XCTAssertNotNil(f.completions.first?.workError)
    }

    @MainActor func testRepeatedUnlockNotificationsDoNotCancelAlreadyApprovedWork() async throws {
        let f = Fixture()
        var resume: CheckedContinuation<Void, Never>?
        try f.begin { await withCheckedContinuation { resume = $0 } }
        try f.unlock()
        await f.settleWork()
        f.runtime.unlocked(try f.scope())
        XCTAssertEqual(f.runtime.phase, .working)
        resume?.resume()
        await f.settleWork()
        try f.confirmLock()
        XCTAssertEqual(f.completions.first?.reason, .finished)
    }

    @MainActor func testImmediateDriverCallbacksCompleteTheSameProtectedAttempt() async throws {
        let f = Fixture()
        var ran = false
        f.driver.onUnlock = { scope in
            guard f.runtime.authorize(f.request()) else { return }
            f.driver.locked = false
            f.runtime.unlocked(scope)
        }
        f.driver.onRelock = { scope in
            f.driver.locked = true
            f.runtime.locked(scope)
        }
        try f.begin { ran = true }
        await f.settleWork()
        XCTAssertTrue(ran)
        XCTAssertEqual(f.completions.first?.reason, .finished)
        XCTAssertFalse(f.desktop.covered)
        XCTAssertFalse(f.guardian.armed)
    }
}
