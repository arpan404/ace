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

    func testWhileLockedMenusAndShortcutsRunOnlyWhenTheSelectedWindowIsTheFocusedOne() {
        // The person locked the Mac with another document in front: Close would close theirs.
        XCTAssertEqual(cuResponderRefusal(preserveHumanFocus: false, locked: true, chosenWindowFocused: false), .lockedOtherWindow)
        XCTAssertNil(cuResponderRefusal(preserveHumanFocus: false, locked: true, chosenWindowFocused: true))
        // Unlocked, the agent makes its window key first, so the focused window does not decide.
        XCTAssertNil(cuResponderRefusal(preserveHumanFocus: false, locked: false, chosenWindowFocused: false))
        XCTAssertEqual(cuResponderRefusal(preserveHumanFocus: true, locked: false, chosenWindowFocused: true), .personFocus)
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
