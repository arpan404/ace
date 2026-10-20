import XCTest
@testable import ScreenHelper

final class ComputerElementFactsTests: XCTestCase {
    func testAKnownElementsActionsAreReusedUntilTheAppReportsAChangeOnIt() {
        var facts = CUElementFacts<String>(maxAgeNs: 1_000)
        facts.read(actions: ["AXPress"], of: "button", at: 0)
        XCTAssertEqual(facts.actions(of: "button", now: 500), ["AXPress"])
        facts.changed("button")
        XCTAssertNil(facts.actions(of: "button", now: 500))
    }
    func testAChangeOnOneElementLeavesOthersCached() {
        var facts = CUElementFacts<String>(maxAgeNs: 1_000)
        facts.read(actions: ["AXPress"], of: "a", at: 0)
        facts.read(actions: ["AXShowMenu"], of: "b", at: 0)
        facts.changed("a")
        XCTAssertEqual(facts.actions(of: "b", now: 10), ["AXShowMenu"])
    }
    func testCachedActionsExpireForAppsThatChangeSilently() {
        var facts = CUElementFacts<String>(maxAgeNs: 1_000)
        facts.read(actions: ["AXPress"], of: "button", at: 0)
        XCTAssertNil(facts.actions(of: "button", now: 1_001))
    }
    func testAnElementObjectReusedWithAnotherRoleForgetsItsActions() {
        var facts = CUElementFacts<String>()
        facts.read(role: "AXButton", of: "element")
        facts.read(actions: ["AXPress"], of: "element", at: 0)
        facts.read(role: "AXStaticText", of: "element")
        XCTAssertEqual(facts.role(of: "element"), "AXStaticText")
        XCTAssertNil(facts.actions(of: "element", now: 1))
    }
    func testADestroyedElementIsForgottenEntirely() {
        var facts = CUElementFacts<String>()
        facts.read(role: "AXButton", of: "element")
        facts.read(actions: ["AXPress"], of: "element", at: 0)
        facts.destroyed("element")
        XCTAssertNil(facts.role(of: "element"))
        XCTAssertNil(facts.actions(of: "element", now: 1))
    }
    func testTheCacheStaysBounded() {
        var facts = CUElementFacts<Int>(capacity: 4)
        for key in 0..<10 { facts.read(role: "AXButton", of: key) }
        XCTAssertEqual((0..<10).filter { facts.role(of: $0) != nil }.count, 2)
    }
}
