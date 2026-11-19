import XCTest
import LockedUseService
import LockedUseTransport

final class ServiceTrustTests: XCTestCase {
    @MainActor func testEnableAndBeginAreRefusedUnlessTheDaemonAssertsTheOptIn() {
        let f = ServiceFixture()
        f.send(#"{"v":1,"id":"e1","type":"enable"}"#)
        f.send(#"{"v":1,"id":"e2","type":"enable","optIn":false}"#)
        f.send(#"{"v":1,"id":"e3","type":"enable","optIn":1}"#)
        for id in ["e1", "e2", "e3"] { XCTAssertEqual(f.failureCode(id), "not_enabled", id) }
        XCTAssertEqual(f.service.status.phase, "disabled")
        f.enable()
        XCTAssertNil(f.failureCode("e"))
        f.send(#"{"v":1,"id":"b","type":"begin","agentProcessIDs":[4242],"scope":{"userID":\#(getuid()),"sessionID":100003,"threadID":"thread","turnID":"turn","attemptID":"attempt-1"}}"#)
        XCTAssertEqual(f.failureCode("b"), "not_enabled")
        XCTAssertTrue(f.unlock.attempts.isEmpty, "No unlock is requested without the opt-in")
        XCTAssertFalse(f.desktop.covered)
        XCTAssertEqual(f.service.status.phase, "disabled", "A missing opt-in turns the feature off")
    }

    @MainActor func testAMissingOptInDuringAnAttemptStopsItAndRelocks() async {
        let f = ServiceFixture()
        f.enable()
        f.begin()
        XCTAssertTrue(f.grant())
        f.setSession(locked: false)
        await f.settle()
        XCTAssertEqual(f.phases.last, "working")
        f.send(#"{"v":1,"id":"e2","type":"enable","optIn":false}"#)
        await f.settle()
        XCTAssertEqual(f.driverLock.count, 1)
        f.setSession(locked: true)
        XCTAssertEqual(f.completions, ["disabled"])
        XCTAssertEqual(f.service.status.phase, "disabled")
    }

    @MainActor func testGracefulShutdownStopsWorkRelocksAndSettlesOnlyAfterTheConfirmedLock() async {
        let f = ServiceFixture()
        f.enable()
        f.begin()
        XCTAssertTrue(f.grant())
        f.setSession(locked: false)
        await f.settle()
        XCTAssertEqual(f.phases.last, "working")
        f.service.shutdown()
        await f.settle()
        f.pulse()
        XCTAssertEqual(f.driverLock.count, 1, "Shutdown requests relock itself")
        XCTAssertFalse(f.service.settled, "Exit waits for the OS to confirm the lock")
        XCTAssertTrue(f.desktop.covered)
        f.setSession(locked: true)
        XCTAssertTrue(f.service.settled)
        XCTAssertEqual(f.completions, ["disabled"])
        XCTAssertEqual(f.guardianServer.state, .idle, "The guardian is disarmed only after the confirmed lock")
    }

    @MainActor func testGracefulShutdownLeavesAnIdleMacAsThePersonHasIt() async {
        let f = ServiceFixture()
        f.facts = ServiceFixture.facts(locked: false)
        f.enable()
        f.service.shutdown()
        await f.settle()
        XCTAssertTrue(f.service.settled)
        XCTAssertEqual(f.driverLock.count, 0, "Nothing was unlocked by ace, so nothing is locked")
        XCTAssertEqual(f.service.status.phase, "disabled")
    }

    @MainActor func testTheGuardianRelocksWhenTheServiceIsKilledMidAttempt() async {
        let f = ServiceFixture()
        f.enable()
        f.begin()
        XCTAssertTrue(f.grant())
        f.setSession(locked: false)
        await f.settle()
        XCTAssertEqual(f.phases.last, "working")
        // SIGKILL runs no shutdown code; the guardian sees the owner process exit.
        f.ownerExited()
        _ = f.guardianServer.state
        XCTAssertEqual(f.guardianLock.count, 1)
        XCTAssertEqual(f.driverLock.count, 0, "The relock came from the guardian alone")
    }
}
