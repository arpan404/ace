import XCTest
@testable import ScreenHelper

final class AccessibilityStateTests: XCTestCase {
    func testExpandedElementsRequestedFalseMustDispatchCollapse() {
        XCTAssertFalse(semanticStateMatches(action: "expand", states: ["expanded"], requested: false))
    }
    func testCollapsedElementsExpandByDefaultAndMatchingStatesAreNoOps() {
        XCTAssertFalse(semanticStateMatches(action: "expand", states: [], requested: nil))
        XCTAssertFalse(semanticStateMatches(action: "expand", states: [], requested: true))
        XCTAssertTrue(semanticStateMatches(action: "expand", states: ["expanded"], requested: true))
        XCTAssertTrue(semanticStateMatches(action: "expand", states: ["expanded"], requested: nil))
        XCTAssertTrue(semanticStateMatches(action: "expand", states: [], requested: false))
    }
}
