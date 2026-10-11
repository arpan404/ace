import XCTest
@testable import ScreenHelper

final class AccessibilityStateTests: XCTestCase {
    func testExpandedElementsRequestedFalseMustDispatchCollapse() {
        XCTAssertFalse(semanticStateMatches(action: "expand", states: ["expanded"], requested: false, expanded: true))
    }
    func testUnreadableOrUnsupportedExpandedStateMustDispatchEvenForCollapse() {
        XCTAssertFalse(semanticStateMatches(action: "expand", states: [], requested: false, expanded: nil))
        XCTAssertFalse(semanticStateMatches(action: "expand", states: ["expanded"], requested: false, expanded: nil))
        XCTAssertFalse(semanticStateMatches(action: "expand", states: [], requested: true, expanded: nil))
    }
    func testCollapsedElementsExpandByDefaultAndMatchingStatesAreNoOps() {
        XCTAssertFalse(semanticStateMatches(action: "expand", states: [], requested: nil, expanded: false))
        XCTAssertFalse(semanticStateMatches(action: "expand", states: [], requested: true, expanded: false))
        XCTAssertTrue(semanticStateMatches(action: "expand", states: ["expanded"], requested: true, expanded: true))
        XCTAssertTrue(semanticStateMatches(action: "expand", states: ["expanded"], requested: nil, expanded: true))
        XCTAssertTrue(semanticStateMatches(action: "expand", states: [], requested: false, expanded: false))
    }
}
