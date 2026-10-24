import XCTest
import LockedUseCore

final class AuthorityTests: XCTestCase {
    private let now: UInt64 = 1_000_000_000
    private var displays: LockedUseDisplays { get throws { try LockedUseDisplays(ids: [11, 22], generation: 1) } }
    private var scope: LockedUseScope { get throws { try work("first") } }
    private var protection: LockedUseProtection { get throws {
        try LockedUseProtection(displays: displays, inputGuardReady: true, relockGuardReady: true)
    } }

    private func work(_ attempt: String) throws -> LockedUseScope {
        try LockedUseScope(userID: 501, sessionID: 42, threadID: "thread", turnID: "approved-turn", attemptID: attempt)
    }

    private func pending() throws -> LockedUseAuthority {
        var authority = LockedUseAuthority()
        try authority.enable()
        XCTAssertEqual(try authority.begin(scope, displays: displays, now: now), [.coverDisplays(try scope)])
        XCTAssertEqual(try authority.protected("first", facts: protection, now: now + 1), [.requestUnlock(try scope)])
        return authority
    }

    private func working() throws -> LockedUseAuthority {
        var authority = try pending()
        XCTAssertTrue(authority.authorize(attemptID: "first", sessionID: 42, requestID: "request", facts: try protection, now: now + 2))
        XCTAssertEqual(try authority.unlocked("first", sessionID: 42, facts: protection, now: now + 3), [.runApprovedWork(try scope)])
        return authority
    }

    func testAnUninstalledOrDisabledAuthorityNeverGrantsAnUnlock() throws {
        var authority = LockedUseAuthority()
        XCTAssertFalse(authority.authorize(attemptID: "first", sessionID: 42, requestID: "request", facts: try protection, now: now))
        XCTAssertThrowsError(try authority.begin(scope, displays: displays, now: now))
    }

    func testNoAuthorizationIsPossibleBeforeEveryProtectionOwnerAcknowledges() throws {
        var authority = LockedUseAuthority()
        try authority.enable()
        _ = try authority.begin(scope, displays: displays, now: now)
        XCTAssertFalse(authority.authorize(attemptID: "first", sessionID: 42, requestID: "request", facts: try protection, now: now + 1))
        let missingGuard = try LockedUseProtection(displays: displays, inputGuardReady: true, relockGuardReady: false)
        XCTAssertEqual(try authority.protected("first", facts: missingGuard, now: now + 2), [.stopWork(try scope, .protectionLost), .relock(try scope)])
        XCTAssertFalse(authority.authorize(attemptID: "first", sessionID: 42, requestID: "request", facts: try protection, now: now + 3))
    }

    func testReplacingADisplayInvalidatesCoverageEvenWhenItsCountIsUnchanged() throws {
        var authority = try pending()
        let changed = try LockedUseProtection(displays: LockedUseDisplays(ids: [11, 33], generation: 2), inputGuardReady: true, relockGuardReady: true)
        XCTAssertEqual(try authority.heartbeat("first", facts: changed, now: now + 2), [.stopWork(try scope, .protectionLost), .relock(try scope)])
        XCTAssertFalse(authority.authorize(attemptID: "first", sessionID: 42, requestID: "request", facts: try protection, now: now + 3))
    }

    func testAnAuthorizationIsBoundToItsAttemptAndSessionAndCanBeConsumedOnlyOnce() throws {
        var authority = try pending()
        XCTAssertFalse(authority.authorize(attemptID: "old", sessionID: 42, requestID: "r", facts: try protection, now: now + 2))
        XCTAssertFalse(authority.authorize(attemptID: "first", sessionID: 77, requestID: "r", facts: try protection, now: now + 2))
        XCTAssertTrue(authority.authorize(attemptID: "first", sessionID: 42, requestID: "r", facts: try protection, now: now + 2))
        XCTAssertFalse(authority.authorize(attemptID: "first", sessionID: 42, requestID: "r", facts: try protection, now: now + 3))
        XCTAssertFalse(authority.authorize(attemptID: "first", sessionID: 42, requestID: "another", facts: try protection, now: now + 3))
    }

    func testMissingHeartbeatsDenyAuthorizationAndRequestRelockWithoutRemovingCovers() throws {
        var authority = try pending()
        XCTAssertFalse(authority.authorize(attemptID: "first", sessionID: 42, requestID: "r", facts: try protection, now: now + 500_000_001))
        XCTAssertEqual(authority.tick(now: now + 500_000_001), [.stopWork(try scope, .protectionLost), .relock(try scope)])
        XCTAssertEqual(authority.phase, .relocking)
    }

    func testAuthorizationExpiresAtTheDeadlineEvenWithFreshProtection() throws {
        var authority = try pending()
        for time in [now + 400_000_000, now + 800_000_000] { _ = try authority.heartbeat("first", facts: protection, now: time) }
        XCTAssertFalse(authority.authorize(attemptID: "first", sessionID: 42, requestID: "r", facts: try protection, now: now + 1_000_000_001))
        XCTAssertEqual(authority.tick(now: now + 1_000_000_001), [.stopWork(try scope, .expired), .relock(try scope)])
    }

    func testAuthorizingDoesNotReportWorkReadyUntilTheOSConfirmsUnlock() throws {
        var authority = try pending()
        XCTAssertTrue(authority.authorize(attemptID: "first", sessionID: 42, requestID: "r", facts: try protection, now: now + 2))
        XCTAssertEqual(authority.phase, .unlocking)
        XCTAssertEqual(try authority.unlocked("first", sessionID: 99, facts: protection, now: now + 3), [.stopWork(try scope, .protectionLost), .relock(try scope)])
    }

    func testCancellationKeepsCoversUntilTheCorrectSessionIsConfirmedLocked() throws {
        var authority = try working()
        XCTAssertEqual(try authority.end("first", reason: .cancelled), [.stopWork(try scope, .cancelled), .relock(try scope)])
        XCTAssertThrowsError(try authority.locked("first", sessionID: 99))
        XCTAssertEqual(authority.phase, .relocking)
        XCTAssertEqual(try authority.locked("first", sessionID: 42), [.removeCovers(try scope)])
        XCTAssertEqual(authority.phase, .ready)
        XCTAssertThrowsError(try authority.begin(scope, displays: displays, now: now + 4))
    }

    func testAStuckRelockNeverClaimsTheDesktopIsSecureAndCanAcceptLateConfirmation() throws {
        var authority = try working()
        _ = try authority.end("first", reason: .connectionLost)
        XCTAssertEqual(authority.tick(now: now + 2_000_000_004), [.relock(try scope)])
        XCTAssertEqual(authority.phase, .faulted)
        XCTAssertEqual(authority.tick(now: now + 2_000_000_005), [.relock(try scope)])
        XCTAssertThrowsError(try authority.begin(work("new"), displays: displays, now: now + 2_000_000_006))
        XCTAssertEqual(try authority.locked("first", sessionID: 42), [.removeCovers(try scope)])
    }

    func testLocalTakeoverCannotBeClearedByLateCallbacksOrReenablingTheSetting() throws {
        var authority = try working()
        XCTAssertEqual(authority.localInput(manualUnlockGeneration: 7), [.stopWork(try scope, .localInput), .relock(try scope)])
        authority.manualUnlockObserved(generation: 8) // Too early: relock is not confirmed.
        _ = try authority.locked("first", sessionID: 42)
        XCTAssertEqual(authority.phase, .manualUnlockRequired)
        _ = authority.disable()
        try authority.enable()
        XCTAssertThrowsError(try authority.begin(work("second"), displays: displays, now: now + 4))
        authority.manualUnlockObserved(generation: 7)
        XCTAssertEqual(authority.phase, .manualUnlockRequired)
        authority.manualUnlockObserved(generation: 8)
        XCTAssertEqual(try authority.begin(work("second"), displays: displays, now: now + 4), [.coverDisplays(try work("second"))])
    }

    func testAnOldTurnCannotRenewOrCancelANewProtectedTurn() throws {
        var authority = try working()
        _ = try authority.end("first", reason: .finished)
        _ = try authority.locked("first", sessionID: 42)
        _ = try authority.begin(work("second"), displays: displays, now: now + 4)
        XCTAssertThrowsError(try authority.heartbeat("first", facts: protection, now: now + 5))
        XCTAssertThrowsError(try authority.end("first", reason: .cancelled))
        XCTAssertEqual(authority.phase, .covering)
    }

    func testClockRegressionStopsWorkInsteadOfExtendingTheLease() throws {
        var authority = try working()
        XCTAssertEqual(authority.tick(now: now - 1), [.stopWork(try scope, .clockChanged), .relock(try scope)])
    }

    func testFreshCoverageIsRequiredAtTheExactAuthorizationDecision() throws {
        var authority = try pending()
        let lostGuard = try LockedUseProtection(displays: displays, inputGuardReady: false, relockGuardReady: true)
        XCTAssertFalse(authority.authorize(attemptID: "first", sessionID: 42, requestID: "r", facts: lostGuard, now: now + 2))
        XCTAssertFalse(authority.authorize(attemptID: "first", sessionID: 42, requestID: "next", facts: try protection, now: now + 3))
        XCTAssertEqual(authority.tick(now: now + 4), [.stopWork(try scope, .protectionLost), .relock(try scope)])
    }

    func testAClockFaultCannotBeErasedByASecondAuthorizationRequest() throws {
        var authority = try pending()
        XCTAssertFalse(authority.authorize(attemptID: "first", sessionID: 42, requestID: "r", facts: try protection, now: now - 1))
        XCTAssertFalse(authority.authorize(attemptID: "first", sessionID: 42, requestID: "next", facts: try protection, now: now + 2))
        XCTAssertEqual(authority.tick(now: now + 3), [.stopWork(try scope, .clockChanged), .relock(try scope)])
    }

    func testHeartbeatsDoNotExtendTheMaximumProtectedWorkInterval() throws {
        var authority = try working()
        for step in 1...149 {
            XCTAssertEqual(try authority.heartbeat("first", facts: protection, now: now + UInt64(step) * 400_000_000), [])
        }
        XCTAssertEqual(authority.tick(now: now + 60_000_000_003), [.stopWork(try scope, .expired), .relock(try scope)])
    }

    func testDisablingDuringAnUnlockStillRelocksBeforeRemovingAnyCover() throws {
        var authority = try pending()
        XCTAssertTrue(authority.authorize(attemptID: "first", sessionID: 42, requestID: "r", facts: try protection, now: now + 2))
        XCTAssertEqual(authority.disable(), [.stopWork(try scope, .disabled), .relock(try scope)])
        XCTAssertEqual(authority.phase, .relocking)
        XCTAssertEqual(try authority.locked("first", sessionID: 42), [.removeCovers(try scope)])
        XCTAssertEqual(authority.phase, .disabled)
    }

    func testTogglingTheSettingWhileIdleDoesNotDisableTheNextCompletedTurn() throws {
        var authority = LockedUseAuthority()
        try authority.enable()
        XCTAssertEqual(authority.disable(), [])
        try authority.enable()
        _ = try authority.begin(scope, displays: displays, now: now)
        _ = try authority.end("first", reason: .finished)
        _ = try authority.locked("first", sessionID: 42)
        XCTAssertEqual(authority.phase, .ready)
        XCTAssertEqual(try authority.begin(work("next"), displays: displays, now: now + 1), [.coverDisplays(try work("next"))])
    }

    func testASleepSizedTimeJumpCannotResumeAPendingAuthorizationWindow() throws {
        var authority = try pending()
        XCTAssertFalse(authority.authorize(attemptID: "first", sessionID: 42, requestID: "late", facts: try protection, now: now + 30_000_000_000))
        XCTAssertEqual(authority.tick(now: now + 30_000_000_001), [.stopWork(try scope, .expired), .relock(try scope)])
    }

    func testDecodingInvalidScopesCannotBypassInitializationChecks() throws {
        let json = try XCTUnwrap(#"{"userID":0,"sessionID":42,"threadID":"t","turnID":"a","attemptID":"b"}"#.data(using: .utf8))
        XCTAssertThrowsError(try JSONDecoder().decode(LockedUseScope.self, from: json))
    }
}
