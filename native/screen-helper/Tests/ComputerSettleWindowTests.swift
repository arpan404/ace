import XCTest
@testable import ScreenHelper

final class ComputerSettleWindowTests: XCTestCase {
    private let ms: UInt64 = 1_000_000
    private func window(minimum: UInt64 = 60, quiet: UInt64 = 150, responded: UInt64 = 60, limit: UInt64 = 2_000) -> CUSettleWindow {
        CUSettleWindow(started: 1_000 * ms, minimumNs: minimum * ms, quietNs: quiet * ms, respondedQuietNs: responded * ms, limit: (1_000 + limit) * ms)
    }

    func testAnAppThatReactsQuicklySettlesAfterTheShortQuiet() {
        let settle = window()
        let acted = 1_000 * ms, reacted = 1_010 * ms
        XCTAssertFalse(settle.settled(now: 1_060 * ms, lastHelperChange: acted, lastAppChange: reacted))
        XCTAssertTrue(settle.settled(now: 1_070 * ms, lastHelperChange: acted, lastAppChange: reacted))
    }
    func testAnAppThatHasNotReactedYetGetsTheFullQuietToStart() {
        let settle = window()
        let acted = 1_000 * ms
        XCTAssertFalse(settle.settled(now: 1_100 * ms, lastHelperChange: acted, lastAppChange: 500 * ms))
        XCTAssertTrue(settle.settled(now: 1_150 * ms, lastHelperChange: acted, lastAppChange: 500 * ms))
        XCTAssertTrue(settle.settled(now: 1_150 * ms, lastHelperChange: acted, lastAppChange: nil))
    }
    func testAnAppStillChangingKeepsTheWaitGoing() {
        let settle = window()
        let acted = 1_000 * ms
        XCTAssertFalse(settle.settled(now: 1_300 * ms, lastHelperChange: acted, lastAppChange: 1_290 * ms))
        XCTAssertTrue(settle.settled(now: 1_350 * ms, lastHelperChange: acted, lastAppChange: 1_290 * ms))
    }
    func testAnotherHelperChangeAfterTheReactionWaitsForTheAppAgain() {
        let settle = window()
        XCTAssertFalse(settle.settled(now: 1_100 * ms, lastHelperChange: 1_050 * ms, lastAppChange: 1_010 * ms))
    }
    func testTheMinimumAndTheLimitBoundTheWait() {
        let settle = window(minimum: 80, limit: 300)
        XCTAssertFalse(settle.settled(now: 1_070 * ms, lastHelperChange: 0, lastAppChange: nil))
        XCTAssertTrue(settle.settled(now: 1_080 * ms, lastHelperChange: 0, lastAppChange: nil))
        XCTAssertTrue(settle.settled(now: 1_300 * ms, lastHelperChange: 1_299 * ms, lastAppChange: 1_299 * ms))
    }
}
