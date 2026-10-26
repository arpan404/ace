import XCTest
import LockedUseUI

final class DisplayCoverageTests: XCTestCase {
    func testEveryIndependentDisplayMustHaveItsOwnCoveredSurface() {
        let displays = [LockedUseDisplaySurface(displayID: 11, renderedBy: 11), LockedUseDisplaySurface(displayID: 22, renderedBy: 22)]
        XCTAssertFalse(lockedUseHasCompleteCoverage(displays, covered: [11]))
        XCTAssertTrue(lockedUseHasCompleteCoverage(displays, covered: [11, 22]))
    }

    func testMirroredDisplaysAreCoveredThroughTheirActualRenderedSurface() {
        let displays = [LockedUseDisplaySurface(displayID: 11, renderedBy: 11), LockedUseDisplaySurface(displayID: 22, renderedBy: 11)]
        XCTAssertTrue(lockedUseHasCompleteCoverage(displays, covered: [11]))
        XCTAssertFalse(lockedUseHasCompleteCoverage(displays, covered: [22]))
        XCTAssertFalse(lockedUseHasCompleteCoverage([], covered: []))
        XCTAssertFalse(lockedUseHasCompleteCoverage([displays[0], displays[0]], covered: [11]))
    }

}
