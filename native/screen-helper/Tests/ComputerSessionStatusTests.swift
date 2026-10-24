import XCTest
@testable import ScreenHelper

final class ComputerSessionStatusTests: XCTestCase {
    func testMissingOrSwitchedOutDesktopNeverAllowsPostedInput() throws {
        for status in [cuSessionStatus(onConsole: nil, loginDone: nil, locked: nil),
                       cuSessionStatus(onConsole: false, loginDone: true, locked: false),
                       cuSessionStatus(onConsole: false, loginDone: true, locked: true),
                       cuSessionStatus(onConsole: true, loginDone: false, locked: nil)] {
            XCTAssertEqual(status, .unavailable)
            XCTAssertThrowsError(try cuRequirePostedInput(status)) { error in
                XCTAssertEqual((error as? CUError)?.code, "session_unavailable")
            }
        }
        XCTAssertNoThrow(try cuRequirePostedInput(cuSessionStatus(onConsole: true, loginDone: true, locked: nil)))
    }

    func testLockingRefusesUnverifiablePostedInputAndUnlockingRestoresIt() throws {
        let locked = cuSessionStatus(onConsole: true, loginDone: true, locked: true)
        XCTAssertThrowsError(try cuRequirePostedInput(locked)) { error in
            XCTAssertEqual((error as? CUError)?.code, "screen_locked")
        }
        XCTAssertNoThrow(try cuRequirePostedInput(cuSessionStatus(onConsole: true, loginDone: true, locked: false)))
    }

    func testCancellationAndEscapeStillWinWhenTheDesktopIsUnavailable() {
        var facts = CUGuardFacts(locked: false, appFrontmost: false, secondsSinceHumanInput: 60, stopRequested: false, sessionAvailable: false)
        XCTAssertThrowsError(try cuGuard(facts, app: "TextEdit")) { error in
            XCTAssertEqual((error as? CUError)?.code, "session_unavailable")
        }
        facts = CUGuardFacts(locked: false, appFrontmost: false, secondsSinceHumanInput: 60, stopRequested: true, sessionAvailable: false)
        XCTAssertThrowsError(try cuGuard(facts, app: "TextEdit")) { error in
            XCTAssertEqual((error as? CUError)?.code, "stopped_by_person")
        }
        facts.cancelled = true
        XCTAssertThrowsError(try cuGuard(facts, app: "TextEdit")) { error in
            XCTAssertEqual((error as? CUError)?.code, "cancelled")
        }
    }
}
