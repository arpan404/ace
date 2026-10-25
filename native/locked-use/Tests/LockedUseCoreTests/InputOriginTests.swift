import XCTest
import LockedUseCore

final class InputOriginTests: XCTestCase {
    func testPhysicalAndUnknownInputStopsTheAgentWhileOnlyOwnedAgentSourcesContinue() {
        XCTAssertTrue(lockedUseIsTakeover(sourcePID: 0, agentProcessIDs: [0, 100]))
        XCTAssertTrue(lockedUseIsTakeover(sourcePID: -1, agentProcessIDs: [100]))
        XCTAssertTrue(lockedUseIsTakeover(sourcePID: 200, agentProcessIDs: [100]))
        XCTAssertFalse(lockedUseIsTakeover(sourcePID: 100, agentProcessIDs: [100]))
    }
}
