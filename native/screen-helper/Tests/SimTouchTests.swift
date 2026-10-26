import XCTest
@testable import ScreenHelper

final class SimTouchTests: XCTestCase {
    func testAStepNamesItsPhaseFingersEdgeAndScreen() throws {
        let step = try XCTUnwrap(SimTouch.parse(#"{"phase":"move","x":0.25,"y":0.75,"x2":0.5,"y2":0.5,"edge":3,"target":3}"#))
        XCTAssertEqual(step.phase, "move")
        XCTAssertEqual(step.x, 0.25)
        XCTAssertEqual(step.y, 0.75)
        XCTAssertEqual(step.second?.x, 0.5)
        XCTAssertEqual(step.edge, 3)
        XCTAssertEqual(step.target, 3)
    }
    func testAPointOffTheScreenIsHeldOnItsEdge() throws {
        let step = try XCTUnwrap(SimTouch.parse(#"{"phase":"down","x":-0.5,"y":1.5,"edge":9}"#))
        XCTAssertEqual(step.x, 0)
        XCTAssertEqual(step.y, 1)
        XCTAssertEqual(step.edge, 4)
        XCTAssertNil(step.second)
    }
    func testLinesThatAreNotStepsAreIgnored() {
        XCTAssertNil(SimTouch.parse("not json"))
        XCTAssertNil(SimTouch.parse(#"{"phase":"hover","x":0.5,"y":0.5}"#))
        XCTAssertNil(SimTouch.parse(#"{"phase":"down","x":0.5}"#))
    }
}
