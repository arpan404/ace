import XCTest
import CoreGraphics
import AppKit
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

final class ComputerChromiumWarmupTests: XCTestCase {
    func testAChromiumWindowShowingOnlyItsFrameIsLookedAtAgain() {
        // What an Electron window returns right after its tree is first asked for.
        let frameOnly = [cuTestNode(1, depth: 0, role: "standard window", axRole: "AXWindow", axActions: []),
                         cuTestNode(2, role: "group", name: "Electron diag", axRole: "AXGroup", axActions: []),
                         cuTestNode(3, depth: 2, role: "group", axRole: "AXGroup", axActions: []),
                         cuTestNode(4, role: "close button"), cuTestNode(5, role: "full screen button"), cuTestNode(6, role: "minimize button")]
        XCTAssertTrue(cuChromiumTreePending(frameOnly))
        let loaded = frameOnly + [cuTestNode(7, depth: 3, role: "HTML content", axRole: "AXWebArea", axActions: []), cuTestNode(8, depth: 4, name: "Press me")]
        XCTAssertFalse(cuChromiumTreePending(loaded))
    }
}

final class ComputerPointerDeliveryTests: XCTestCase {
    func testMouseAndWheelEventsCarryTheAddressedWindowAndLocalPosition() throws {
        typealias Location = @convention(c) (CGEvent) -> CGPoint
        let symbol = try XCTUnwrap(dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventGetWindowLocation"))
        let location = unsafeBitCast(symbol, to: Location.self)
        let target = CUPointerTarget(window: 42, frame: CGRect(x: -1000, y: 200, width: 700, height: 532))
        let point = CGPoint(x: -880, y: 276)
        let click = try XCTUnwrap(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left))
        let wheel = try XCTUnwrap(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -120, wheel2: 0, wheel3: 0))
        for event in [click, wheel] {
            cuAddressToWindow(event, target: target, at: point)
            let received = try XCTUnwrap(NSEvent(cgEvent: event))
            XCTAssertEqual(received.windowNumber, 42)
            // A decoder in this test process has no NSWindow 42. The receiving process
            // uses this event location when resolving its own window 42.
            XCTAssertEqual(location(event), CGPoint(x: 120, y: 76))
        }
    }
    func testCoveredWindowsGetAddressedEventsRegardlessOfTheWindowUnderThePersonsPointer() {
        XCTAssertEqual(cuPointerDelivery(onScreen: true, otherSpace: false, minimized: false, hasWindowNumber: true), .windowTargeted)
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
