import XCTest
import LockedUseCore
import LockedUseGuardianKit
import LockedUseService
import LockedUseTransport

final class ServiceTests: XCTestCase {
    @MainActor func testAnApprovedTurnWorksOnlyAfterAnObservedUnlockAndCompletesOnlyAfterRelock() async {
        let f = ServiceFixture()
        f.enable()
        f.begin()
        XCTAssertNil(f.failureCode("b-attempt-1"))
        XCTAssertEqual(f.unlock.attempts, ["attempt-1"])
        XCTAssertEqual(f.desktop.agents, [4242])
        XCTAssertTrue(f.grant())
        f.pulse()
        await f.settle()
        XCTAssertFalse(f.phases.contains("working"), "A granted right is not an unlocked desktop")
        f.setSession(locked: false)
        await f.settle()
        XCTAssertEqual(f.phases.last, "working")
        f.send(#"{"v":1,"id":"f","type":"finish","attemptID":"attempt-1"}"#)
        await f.settle()
        f.pulse()
        XCTAssertEqual(f.driverLock.count, 1)
        XCTAssertTrue(f.completions.isEmpty, "Completion waits for a confirmed OS lock")
        XCTAssertTrue(f.desktop.covered)
        f.setSession(locked: true)
        XCTAssertEqual(f.completions, ["finished"])
        XCTAssertFalse(f.desktop.covered)
        XCTAssertEqual(f.guardianServer.state, .idle, "The guardian is disarmed only after the confirmed lock")
    }

    @MainActor func testBeginIsRefusedWithAClearErrorUntilInstallationIsVerified() {
        let f = ServiceFixture()
        f.installed = false
        f.enable()
        XCTAssertEqual(f.failureCode("e"), "not_installed")
        f.begin()
        XCTAssertEqual(f.failureCode("b-attempt-1"), "not_installed")
        XCTAssertTrue(f.unlock.attempts.isEmpty)
        XCTAssertFalse(f.desktop.covered)
    }

    @MainActor func testBeginIsRefusedWhileTheMacIsUnlocked() {
        let f = ServiceFixture()
        f.facts = ServiceFixture.facts(locked: false)
        f.enable()
        f.begin()
        XCTAssertEqual(f.failureCode("b-attempt-1"), "not_locked")
        f.facts = ServiceFixture.facts(locked: true)
        f.begin()
        XCTAssertNil(f.failureCode("b-attempt-1").flatMap { $0 == "busy" ? $0 : nil }, "A refused begin leaves no attempt behind")
    }

    @MainActor func testADaemonDisconnectRelocksAndStillWaitsForTheConfirmedLock() async {
        let f = ServiceFixture()
        f.enable()
        f.begin()
        XCTAssertTrue(f.grant())
        f.setSession(locked: false)
        await f.settle()
        f.service.daemonDisconnected()
        await f.settle()
        f.pulse()
        XCTAssertEqual(f.driverLock.count, 1)
        XCTAssertTrue(f.completions.isEmpty)
        f.setSession(locked: true)
        XCTAssertEqual(f.completions, ["connectionLost"])
    }

    @MainActor func testLocalInputStopsWorkAndRequiresAManualUnlockBeforeTheNextAttempt() async {
        let f = ServiceFixture()
        f.enable()
        f.begin()
        XCTAssertTrue(f.grant())
        f.setSession(locked: false)
        await f.settle()
        f.desktop.takeover?(f.scope)
        await f.settle()
        XCTAssertEqual(f.driverLock.count, 1)
        f.setSession(locked: true)
        XCTAssertEqual(f.completions, ["localInput"])
        f.begin("attempt-2")
        XCTAssertEqual(f.failureCode("b-attempt-2"), "manual_unlock_required")
        f.setSession(locked: false)
        f.setSession(locked: true)
        f.begin("attempt-3")
        XCTAssertNil(f.failureCode("b-attempt-3"), "A manual unlock observed by the service clears the latch")
    }

    @MainActor func testTheGuardianRelocksWhenTheServiceStopsHeartbeating() async {
        let f = ServiceFixture()
        f.enable()
        f.begin()
        XCTAssertTrue(f.grant())
        f.setSession(locked: false)
        await f.settle()
        XCTAssertEqual(f.phases.last, "working")
        // The service hangs or dies: no more pulses, no more coordinator instructions.
        f.advanceGuardian(LockedUseWatchdog.heartbeatTimeout)
        f.guardianServer.tick()
        _ = f.guardianServer.state
        XCTAssertEqual(f.guardianLock.count, 1)
        XCTAssertEqual(f.driverLock.count, 0, "The relock came from the guardian alone")
    }

    @MainActor func testBadDaemonInputGetsErrorsWithoutDisturbingAnAttempt() async {
        let f = ServiceFixture()
        f.enable()
        f.begin()
        f.send("{nope")
        f.send(#"{"v":1,"id":"x","type":"teleport"}"#)
        f.send(#"{"v":1,"id":"y","type":"finish","attemptID":"someone-else"}"#)
        f.send(#"{"v":1,"id":"z","type":"cancel","attemptID":"someone-else"}"#)
        XCTAssertTrue(f.sent.contains(.error(LockedUseWireError(code: "malformed", message: "expected a JSON object"), attemptID: nil)))
        XCTAssertEqual(f.failureCode("x"), "unsupported")
        XCTAssertEqual(f.failureCode("y"), "unknown_attempt")
        XCTAssertEqual(f.failureCode("z"), "unknown_attempt")
        XCTAssertEqual(f.driverLock.count, 0)
        XCTAssertTrue(f.grant(), "The attempt is still intact")
    }

    @MainActor func testStatusReportsTheSessionTheDaemonMustScopeTo() {
        let f = ServiceFixture()
        f.send(#"{"v":1,"id":"s","type":"status"}"#)
        guard case .reply(_, let status)? = f.replies("s").first else { return XCTFail("No status reply") }
        XCTAssertEqual(status?.session, "locked")
        XCTAssertEqual(status?.userID, getuid())
        XCTAssertEqual(status?.sessionID, 100_003)
        XCTAssertEqual(status?.phase, "disabled")
        f.installed = false
        f.send(#"{"v":1,"id":"t","type":"status"}"#)
        guard case .reply(_, let second)? = f.replies("t").first else { return XCTFail("No status reply") }
        XCTAssertEqual(second?.installation.verified, false)
    }
}
