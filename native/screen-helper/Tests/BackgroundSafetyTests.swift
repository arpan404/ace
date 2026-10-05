import XCTest
import CoreGraphics
@testable import ScreenHelper

final class BackgroundSafetyTests: XCTestCase {
    func testFocusAndCursorViolationsBothRequestRestoration() {
        let before = FocusState(pid: 42, cursor: CGPoint(x: 10, y: 20))
        let quiet = FocusDecision(before: before, after: before)
        XCTAssertFalse(quiet.changed)
        let activation = FocusDecision(before: before, after: FocusState(pid: 99, cursor: before.cursor))
        XCTAssertTrue(activation.changed)
        XCTAssertTrue(activation.restoreFocus)
        XCTAssertFalse(activation.restoreCursor)
        let moved = FocusDecision(before: before, after: FocusState(pid: 42, cursor: CGPoint(x: 11, y: 20)))
        XCTAssertTrue(moved.changed)
        XCTAssertFalse(moved.restoreFocus)
        XCTAssertTrue(moved.restoreCursor)
    }
    func testClipboardRestorationDoesNotOverwriteAnotherWritersCopy() {
        XCTAssertTrue(shouldRestoreClipboard(savedChange: 7, currentChange: 7))
        XCTAssertFalse(shouldRestoreClipboard(savedChange: 7, currentChange: 8))
    }
}
