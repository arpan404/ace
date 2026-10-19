import XCTest
import CoreGraphics
@testable import ScreenHelper

final class ComputerKeyRouteTests: XCTestCase {
    private func facts(frontmost: Bool = false, number: Bool = true, onScreen: Bool = false, otherSpace: Bool = false, minimized: Bool = false) -> CUKeyRouteFacts {
        CUKeyRouteFacts(appFrontmost: frontmost, hasWindowNumber: number, onScreen: onScreen, otherSpace: otherSpace, minimized: minimized)
    }

    func testAFrontmostAppIsLeftToRouteKeysItself() {
        XCTAssertEqual(cuKeyRoute(facts(frontmost: true, onScreen: true)), .frontmost)
        XCTAssertEqual(cuKeyRoute(facts(frontmost: true, otherSpace: true)), .frontmost)
    }

    func testAWindowOnTheCurrentScreenKeepsTheFocusRecords() {
        XCTAssertEqual(cuKeyRoute(facts(onScreen: true)), .focusRecords)
    }

    func testAWindowOnAnotherSpaceIsActivatedInsideTheAppOnly() {
        XCTAssertEqual(cuKeyRoute(facts(otherSpace: true)), .innerActivation)
    }

    func testAMinimizedWindowIsNeverActivatedInside() {
        XCTAssertEqual(cuKeyRoute(facts(otherSpace: true, minimized: true)), .focusRecords)
        XCTAssertEqual(cuKeyRoute(facts(minimized: true)), .focusRecords)
    }

    func testAWindowWithoutAWindowServerIdIsNotMadeKey() {
        XCTAssertEqual(cuKeyRoute(facts(number: false, otherSpace: true)), CUKeyRoute.none)
    }
}

final class ComputerPointerDeliveryTests: XCTestCase {
    func testOnScreenWindowsLetTheWindowServerFindTheWindowUnderThePoint() {
        XCTAssertEqual(cuPointerDelivery(onScreen: true, otherSpace: false, minimized: false, hasWindowNumber: true), .windowServer)
    }

    func testWindowsOnAnotherSpaceGetEventsAddressedToThem() {
        XCTAssertEqual(cuPointerDelivery(onScreen: false, otherSpace: true, minimized: false, hasWindowNumber: true), .windowTargeted)
    }

    func testMinimizedHiddenAndUnnumberedWindowsCannotTakePointerEvents() {
        XCTAssertEqual(cuPointerDelivery(onScreen: false, otherSpace: false, minimized: true, hasWindowNumber: true), .unavailable)
        XCTAssertEqual(cuPointerDelivery(onScreen: false, otherSpace: false, minimized: false, hasWindowNumber: true), .unavailable)
        XCTAssertEqual(cuPointerDelivery(onScreen: true, otherSpace: false, minimized: false, hasWindowNumber: false), .unavailable)
    }

    func testAnAddressedEventCarriesThePointInTheWindowsOwnCoordinates() {
        let target = CUPointerTarget(window: 42, frame: CGRect(x: 200, y: 708, width: 700, height: 532))
        // A button 120 points right of the window's left edge and 76 below its top (title bar included).
        XCTAssertEqual(cuWindowPoint(CGPoint(x: 320, y: 784), in: target), CGPoint(x: 120, y: 76))
        // A window on a display left of the main one has a negative origin.
        let left = CUPointerTarget(window: 7, frame: CGRect(x: -1500, y: 100, width: 800, height: 600))
        XCTAssertEqual(cuWindowPoint(CGPoint(x: -1400, y: 150), in: left), CGPoint(x: 100, y: 50))
    }

    func testPointClicksInAnOffSpaceWindowArePostedAtThePointLikeOnScreen() {
        // Text inside a button: a real click at the point, now that the event can land there.
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: false, role: "AXStaticText", pressableAncestor: true, pointerLands: true)), .post)
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: false, count: 2, role: "AXTextArea", pointerLands: true)), .post)
    }
}
