import XCTest
@testable import ScreenHelper

final class ComputerLatencyTests: XCTestCase {
    private func unavailableFocus() throws -> Bool { throw CUError("focus_unavailable", "The app is not answering focus queries") }

    func testBackgroundAndIdleActionsDoNotDependOnTheAppsHumanFocusResponding() throws {
        for facts in [
            CUGuardFacts(locked: false, appFrontmost: false, secondsSinceHumanInput: 0, stopRequested: false),
            CUGuardFacts(locked: false, appFrontmost: true, secondsSinceHumanInput: 2, stopRequested: false),
            CUGuardFacts(locked: true, appFrontmost: true, secondsSinceHumanInput: 0, stopRequested: false),
        ] {
            XCTAssertNoThrow(try cuGuard(facts, app: "Fixture", conflict: unavailableFocus))
        }
    }

    func testHumanInputStillRefusesAConflictingControlAndAllowsAnIndependentOne() throws {
        let facts = CUGuardFacts(locked: false, appFrontmost: true, secondsSinceHumanInput: 0, stopRequested: false)
        XCTAssertThrowsError(try cuGuard(facts, app: "Fixture", conflict: { true })) {
            XCTAssertEqual(($0 as? CUError)?.code, "person_active")
        }
        XCTAssertNoThrow(try cuGuard(facts, app: "Fixture", conflict: { false }))
    }

    func testStopAndSessionFailureDoNotWaitForAnUnresponsiveFocusQuery() {
        for (facts, code) in [
            (CUGuardFacts(locked: false, appFrontmost: true, secondsSinceHumanInput: 0, stopRequested: true), "stopped_by_person"),
            (CUGuardFacts(locked: false, appFrontmost: true, secondsSinceHumanInput: 0, stopRequested: false, cancelled: true), "cancelled"),
            (CUGuardFacts(locked: false, appFrontmost: true, secondsSinceHumanInput: 0, stopRequested: false, sessionAvailable: false), "session_unavailable"),
        ] {
            XCTAssertThrowsError(try cuGuard(facts, app: "Fixture", conflict: unavailableFocus)) {
                XCTAssertEqual(($0 as? CUError)?.code, code)
            }
        }
    }

    func testExplicitWaitsOwnTheirSynchronizationButDependentActionsStillSettle() {
        let click: CUObject = ["type": "click", "id": 1]
        XCTAssertFalse(cuNeedsSettleAfter(click, next: ["type": "wait_for", "text": "Saved"], skipped: false))
        XCTAssertFalse(cuNeedsSettleAfter(click, next: ["type": "wait", "ms": 500], skipped: false))
        XCTAssertTrue(cuNeedsSettleAfter(click, next: ["type": "type", "text": "hello"], skipped: false))
        XCTAssertTrue(cuNeedsSettleAfter(click, next: ["type": "wait_for", "text": "Saved", "when": ["text": "Ready"]], skipped: false))
        XCTAssertTrue(cuNeedsSettleAfter(["type": "type", "text": "submit\n"], next: ["type": "type", "text": "next"], skipped: false))
    }

    func testASkippedConditionalDoesNotAddAQuietWaitForAnActionThatNeverRan() {
        XCTAssertFalse(cuNeedsSettleAfter(["type": "click", "when": ["text": "Optional"]],
            next: ["type": "type", "text": "hello"], skipped: true))
    }
}
