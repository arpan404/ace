import XCTest
import CoreGraphics
@testable import ScreenHelper

/// The one place tests build outline nodes.
func cuTestNode(_ id: Int, depth: Int = 1, role: String = "button", name: String? = nil, value: String? = nil, placeholder: String? = nil,
                frame: CGRect? = nil, axRole: String = "AXButton", axActions: [String] = ["AXPress"]) -> CUNode {
    CUNode(id: id, depth: depth, role: role, flags: [], name: name, value: value, detail: nil, placeholder: placeholder, url: nil,
           actions: [], frame: frame, axActions: axActions, axRole: axRole)
}

final class ComputerClickRouteTests: XCTestCase {
    func testPlainClicksOnNamedElementsGoThroughAccessibility() {
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: true, actions: ["AXPress"], role: "AXButton")), .press)
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: true, role: "AXTextField")), .focus)
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: true, role: "AXStaticText", selectableRow: true)), .selectRow)
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: true, role: "AXStaticText", pressableAncestor: true)), .pressAncestor)
    }

    func testModifiersHoldsAndMiddleClicksArePostedAsRealMouseEvents() {
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: true, modified: true, actions: ["AXPress"])), .post)
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: true, button: .middle, actions: ["AXPress"])), .post)
    }

    func testPointClicksPressOnlyWhenTheHitElementItselfIsPressable() {
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: false, actions: ["AXPress"], role: "AXButton")), .press)
        // Text inside a button, or a field (where the caret should land at the point): a real click.
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: false, role: "AXStaticText", pressableAncestor: true)), .post)
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: false, role: "AXTextArea")), .post)
        // Off screen a real click cannot land, so the nearest accessibility equivalent is tried.
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: false, role: "AXStaticText", pressableAncestor: true, onScreen: false)), .pressAncestor)
    }

    func testRightClicksOpenTheContextMenuThroughAccessibilityWhenOffered() {
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: true, button: .right, actions: ["AXShowMenu"])), .showMenu)
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: true, button: .right, actions: ["AXPress"])), .post)
    }

    func testDoubleAndTripleClicksOpenOrSelectText() {
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: true, count: 2, actions: ["AXOpen"])), .open)
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: true, count: 2, role: "AXTextArea")), .selectWord)
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: true, count: 3, role: "AXTextArea")), .selectLine)
        XCTAssertEqual(cuClickRoute(CUClickFacts(byId: false, count: 2, role: "AXTextArea")), .post)
    }
}

final class ComputerHitTestTests: XCTestCase {
    private let window = CGRect(x: 0, y: 0, width: 400, height: 300)

    func testTheSmallestActingElementUnderThePointIsHit() {
        let nodes = [
            cuTestNode(1, depth: 0, frame: window, axRole: "AXWindow"),
            cuTestNode(2, frame: CGRect(x: 0, y: 0, width: 200, height: 100), axRole: "AXGroup", axActions: []),
            cuTestNode(3, depth: 2, frame: CGRect(x: 10, y: 10, width: 60, height: 20)),
            cuTestNode(4, depth: 3, frame: CGRect(x: 12, y: 12, width: 30, height: 10), axRole: "AXStaticText", axActions: []),
        ]
        XCTAssertEqual(cuHitTest(nodes: nodes, point: CGPoint(x: 20, y: 15)), 3)
        XCTAssertEqual(cuHitTest(nodes: nodes, point: CGPoint(x: 150, y: 80)), 2)
    }

    func testAnOpenSheetHidesTheWindowBehindIt() {
        let nodes = [
            cuTestNode(1, depth: 0, frame: window, axRole: "AXWindow"),
            cuTestNode(2, frame: CGRect(x: 10, y: 10, width: 60, height: 20)),
            cuTestNode(3, frame: CGRect(x: 100, y: 0, width: 200, height: 150), axRole: "AXSheet", axActions: []),
            cuTestNode(4, depth: 2, frame: CGRect(x: 120, y: 100, width: 60, height: 20)),
        ]
        XCTAssertEqual(cuHitTest(nodes: nodes, point: CGPoint(x: 130, y: 110)), 4)
        XCTAssertNil(cuHitTest(nodes: nodes, point: CGPoint(x: 20, y: 15)))
    }
}

final class ComputerPointerPlanTests: XCTestCase {
    func testDoubleClicksRaiseTheClickStateAndHoldKeepsTheLastPressDown() {
        let events = cuClickEvents(at: CGPoint(x: 5, y: 5), button: .left, count: 2, holdMs: 700)
        XCTAssertEqual(events.map(\.kind), [.move, .down, .up, .down, .up])
        XCTAssertEqual(events.filter { $0.kind != .move }.map(\.clickState), [1, 1, 2, 2])
        XCTAssertEqual(events[3].delayMs, 700)
    }

    func testDragsPressOnceGlideAndReleaseOnTheTarget() {
        let start = CGPoint(x: 0, y: 0), end = CGPoint(x: 300, y: 0)
        let events = cuDragEvents(from: start, to: end, holdMs: 500)
        XCTAssertEqual(events.first?.kind, .move)
        XCTAssertEqual(events[1].kind, .down)
        XCTAssertEqual(events[1].clickState, 1)
        XCTAssertGreaterThanOrEqual(events[1].delayMs, 500)
        let drags = events.filter { $0.kind == .drag }
        XCTAssertGreaterThanOrEqual(drags.count, 8)
        XCTAssertTrue(drags.allSatisfy { $0.clickState == 1 })
        XCTAssertEqual(drags.map(\.point.x), drags.map(\.point.x).sorted())
        XCTAssertEqual(events.last?.kind, .up)
        XCTAssertEqual(events.last?.point, end)
        XCTAssertEqual(events.filter { $0.kind == .down }.count, 1)
    }

    func testHorizontalPagesUseTheVisibleWidth() {
        let viewport = CGSize(width: 1000, height: 500)
        XCTAssertEqual(cuScrollDistance(direction: "right", pages: 1, pixels: nil, viewport: viewport), 800)
        XCTAssertEqual(cuScrollDistance(direction: "down", pages: 2, pixels: nil, viewport: viewport), 800)
        XCTAssertEqual(cuScrollDistance(direction: "down", pages: nil, pixels: 123, viewport: viewport), 123)
    }

    func testLargeScrollsSplitIntoSeveralWheelEvents() {
        XCTAssertEqual(cuWheelDeltas(direction: "down", distance: 1000), [CUWheelDelta(dx: 0, dy: -400), CUWheelDelta(dx: 0, dy: -400), CUWheelDelta(dx: 0, dy: -200)])
        XCTAssertEqual(cuWheelDeltas(direction: "left", distance: 50), [CUWheelDelta(dx: 50, dy: 0)])
    }

    func testRevealMovesContentOnlyWhenTheElementIsOutOfView() {
        let view = CGRect(x: 0, y: 100, width: 400, height: 300)
        XCTAssertEqual(cuRevealOffset(element: CGRect(x: 10, y: 500, width: 50, height: 20), visible: view), CGVector(dx: 0, dy: 120))
        XCTAssertEqual(cuRevealOffset(element: CGRect(x: 10, y: 40, width: 50, height: 20), visible: view), CGVector(dx: 0, dy: -60))
        XCTAssertEqual(cuRevealOffset(element: CGRect(x: 10, y: 150, width: 50, height: 20), visible: view), CGVector(dx: 0, dy: 0))
        // Taller than the view: in view once it overlaps, otherwise its near edge comes in.
        XCTAssertEqual(cuRevealOffset(element: CGRect(x: 10, y: 104, width: 50, height: 900), visible: view), CGVector(dx: 0, dy: 0))
        XCTAssertEqual(cuRevealOffset(element: CGRect(x: 10, y: 600, width: 50, height: 900), visible: view), CGVector(dx: 0, dy: 500))
    }

    func testEditMenuTextCommandsAreRecognisedByTitle() {
        XCTAssertEqual(cuMenuTextCommand("Copy"), .copy)
        XCTAssertEqual(cuMenuTextCommand("Select All"), .selectAll)
        XCTAssertNil(cuMenuTextCommand("Copy Style"))
    }

    func testDoubleClickSelectsTheWordAroundTheHit() {
        XCTAssertEqual(cuWordRange(in: "hello big_world!", at: 8), NSRange(location: 6, length: 9))
        XCTAssertEqual(cuWordRange(in: "a, b", at: 1), NSRange(location: 1, length: 1))
    }
}

final class ComputerMenuTests: XCTestCase {
    func testExactTitlesWinOverPrefixes() {
        XCTAssertEqual(cuChooseMenuItem(titles: ["Close All", "Close"], wanted: "close"), .found(1))
        XCTAssertEqual(cuChooseMenuItem(titles: ["Save", "Export…"], wanted: "Export"), .found(1))
    }

    func testPrefixesCountOnlyWhenUnique() {
        XCTAssertEqual(cuChooseMenuItem(titles: ["Duplicate", "Delete"], wanted: "Dup"), .found(0))
        XCTAssertEqual(cuChooseMenuItem(titles: ["Close Tab", "Close Window"], wanted: "Close"), .ambiguous(["Close Tab", "Close Window"]))
        XCTAssertEqual(cuChooseMenuItem(titles: ["Open"], wanted: "Quit"), .missing)
    }

    func testOnlyWholeWindowCommandsUseTheWindowsButtons() {
        XCTAssertEqual(cuWindowButtonAttribute(forCommand: "Close"), "AXCloseButton")
        XCTAssertEqual(cuWindowButtonAttribute(forCommand: "Close Window"), "AXCloseButton")
        XCTAssertNil(cuWindowButtonAttribute(forCommand: "Close Tab"))
        XCTAssertNil(cuWindowButtonAttribute(forCommand: "Close Editor"))
        XCTAssertNil(cuWindowButtonAttribute(forCommand: "Close Other Tabs"))
        XCTAssertNil(cuWindowButtonAttribute(forCommand: "Close All"))
        XCTAssertEqual(cuWindowButtonAttribute(forCommand: "Minimize"), "AXMinimizeButton")
        XCTAssertNil(cuWindowButtonAttribute(forCommand: "Minimize All"))
    }
}

final class ComputerConditionTests: XCTestCase {
    private let nodes = [
        cuTestNode(1, role: "button", name: "Save"),
        cuTestNode(2, role: "text field", value: "Draft 3", axRole: "AXTextField", axActions: []),
        cuTestNode(3, role: "search field", placeholder: "Search mail", axRole: "AXSearchField", axActions: []),
    ]

    private func holds(_ object: CUObject) throws -> Bool {
        cuConditionHolds(try XCTUnwrap(try cuCondition(object)), nodes: nodes)
    }

    func testTextConditionsMatchAnyPartOfTheOutlineLineIgnoringCase() throws {
        XCTAssertTrue(try holds(["text": "save"]))
        XCTAssertTrue(try holds(["text": "draft"]))
        XCTAssertTrue(try holds(["text": "SEARCH MAIL"]))
        XCTAssertFalse(try holds(["text": "Sent"]))
    }

    func testIdConditionsAndGoneInvertPresence() throws {
        XCTAssertTrue(try holds(["id": 2]))
        XCTAssertTrue(try holds(["id": 9, "gone": true]))
        XCTAssertFalse(try holds(["text": "Save", "gone": true]))
        XCTAssertTrue(try holds(["id": 2, "text": "draft"]))
        XCTAssertFalse(try holds(["id": 1, "text": "draft"]))
    }

    func testMissingConditionsAreAbsentAndEmptyOnesAreRejected() throws {
        XCTAssertNil(try cuCondition(nil))
        XCTAssertThrowsError(try cuCondition(["gone": true] as CUObject))
        XCTAssertThrowsError(try cuCondition("Saved"))
    }
}

final class ComputerTextFindTests: XCTestCase {
    func testSuffixAndPrefixPickTheRightOccurrence() {
        let text = "cat sat; cat ran; cat sat"
        XCTAssertEqual(cuFindText("cat", in: text, prefix: nil, suffix: " ran"), NSRange(location: 9, length: 3))
        XCTAssertEqual(cuFindText("cat", in: text, prefix: "; ", suffix: " sat"), NSRange(location: 18, length: 3))
    }

    func testRepeatedTextWithoutMatchingAnchorsIsNotGuessed() {
        XCTAssertNil(cuFindText("cat", in: "cat cat", prefix: "dog ", suffix: nil))
        XCTAssertEqual(cuFindText("cat", in: "a cat", prefix: "dog ", suffix: nil), NSRange(location: 2, length: 3))
        XCTAssertEqual(cuFindText("cat", in: "cat cat", prefix: nil, suffix: nil), NSRange(location: 0, length: 3))
    }

    func testCopiedTextIsReportedUpTo500Characters() {
        XCTAssertEqual(cuCopiedLine("hi"), "Copied: \"hi\"")
        XCTAssertEqual(cuCopiedLine(String(repeating: "x", count: 600)), "Copied: \"\(String(repeating: "x", count: 500))…\"")
    }
}
