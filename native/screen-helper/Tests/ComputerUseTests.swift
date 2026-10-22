import XCTest
import CoreGraphics
@testable import ScreenHelper

final class ComputerGuardTests: XCTestCase {
    func testIndependentControlsInTheSameTabCanBeEditedWithoutTakingThePersonsCaret() {
        var target = CUHumanTargetFacts(observing: false, explicitTarget: true, sameWindow: true,
                                       focusKnown: true, containsFocus: false, pointerAction: false, cursorOnTarget: false)
        XCTAssertFalse(cuConflictsWithHuman(target))
        target.containsFocus = true
        XCTAssertTrue(cuConflictsWithHuman(target))
        target.containsFocus = false
        target.pointerAction = true
        target.cursorOnTarget = true
        XCTAssertTrue(cuConflictsWithHuman(target))
        target.explicitTarget = false
        target.sameWindow = false
        XCTAssertFalse(cuConflictsWithHuman(target))
    }

    private func facts(locked: Bool = false, front: Bool = false, idle: Double = 60, stop: Bool = false) -> CUGuardFacts {
        CUGuardFacts(locked: locked, appFrontmost: front, secondsSinceHumanInput: idle, stopRequested: stop)
    }

    func testAgentWorksInBackgroundAppsWhileThePersonTypesElsewhere() {
        XCTAssertNoThrow(try cuGuard(facts(front: false, idle: 0.1), app: "Notes"))
    }

    func testThePersonCanTypeInAnotherWindowOfTheSameApp() {
        var shared = facts(front: true, idle: 0)
        shared.conflictsWithHuman = false
        XCTAssertNoThrow(try cuGuard(shared, app: "Safari"))
        shared.conflictsWithHuman = true
        XCTAssertThrowsError(try cuGuard(shared, app: "Safari"))
    }

    func testAgentWaitsWhileThePersonIsUsingTheSameApp() {
        XCTAssertThrowsError(try cuGuard(facts(front: true, idle: 0.3), app: "Notes")) { error in
            XCTAssertEqual((error as? CUError)?.code, "person_active")
        }
        XCTAssertNoThrow(try cuGuard(facts(front: true, idle: 5), app: "Notes"))
    }

    func testEscapeStopsTheAgentEvenWhileLocked() {
        XCTAssertEqual(Self.code { try cuGuard(self.facts(stop: true), app: "Notes") }, "stopped_by_person")
        XCTAssertEqual(Self.code { try cuGuard(self.facts(locked: true, stop: true), app: "Notes") }, "stopped_by_person")
    }

    func testLockingDoesNotPreventBackgroundAccessibilityWork() {
        XCTAssertNoThrow(try cuGuard(facts(locked: true), app: "Notes"))
        // isActive can retain the app that was frontmost before the lock screen appeared.
        XCTAssertNoThrow(try cuGuard(facts(locked: true, front: true, idle: 0), app: "Notes"))
    }

    private static func code(_ body: () throws -> Void) -> String? {
        do { try body(); return nil } catch { return (error as? CUError)?.code }
    }
}

final class ComputerPasteTests: XCTestCase {
    func testMarkdownKeepsHeadingsListsEmphasisAndLinks() {
        let html = cuMarkdownHTML("# Title\n\nSome **bold** and *soft* `code` with [a link](https://example.com).\n\n- one\n- two\n\n1. first")
        XCTAssertEqual(html, "<h1>Title</h1><p>Some <strong>bold</strong> and <em>soft</em> <code>code</code> with <a href=\"https://example.com\">a link</a>.</p><ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>")
    }

    func testMarkdownCodeBlocksAreEscapedVerbatim() {
        XCTAssertEqual(cuMarkdownHTML("```\nif a < b { **x** }\n```"), "<pre><code>if a &lt; b { **x** }</code></pre>")
    }

    func testRichPasteFallsBackToPlainTextWithLineBreaks() throws {
        let content = try cuPasteContent("# Title\n\n- one\n- two", format: "markdown")
        XCTAssertNotNil(content.html)
        XCTAssertTrue(content.plain.hasPrefix("Title\n"))
        XCTAssertTrue(content.plain.contains("one"))
        XCTAssertEqual(try cuPasteContent("plain", format: "text"), CUPasteContent(plain: "plain", html: nil))
    }
}

final class ComputerScreenshotTests: XCTestCase {
    func testScreenshotsFitWhatModelsReadWithoutResizing() {
        let large = cuScreenshotScale(points: CGSize(width: 1728, height: 1084), backing: 2)
        XCTAssertLessThanOrEqual(1728 * large * 1084 * large, 1_150_001)
        XCTAssertLessThanOrEqual(1728 * large, 1568)
        XCTAssertEqual(cuScreenshotScale(points: CGSize(width: 300, height: 200), backing: 2), 2)
    }

    func testMarksTagActionableElementsInsideTheWindowOnly() {
        let window = CGRect(x: 100, y: 100, width: 400, height: 300)
        let marks = cuMarks(nodes: [
            cuTestNode(1, depth: 0, frame: window, axRole: "AXWindow"),
            cuTestNode(2, frame: CGRect(x: 110, y: 120, width: 40, height: 20)),
            cuTestNode(3, frame: CGRect(x: 110, y: 160, width: 40, height: 20), axRole: "AXStaticText", axActions: []),
            cuTestNode(4, frame: CGRect(x: 900, y: 900, width: 40, height: 20)),
        ], window: window, scale: 2)
        XCTAssertEqual(marks, [CUMark(id: 2, rect: CGRect(x: 20, y: 40, width: 80, height: 40))])
    }

    func testRowsScrolledOutOfTheirListAreNotTagged() {
        let window = CGRect(x: 0, y: 0, width: 400, height: 400)
        let marks = cuMarks(nodes: [
            cuTestNode(1, depth: 0, frame: window, axRole: "AXWindow"),
            cuTestNode(2, depth: 1, frame: CGRect(x: 0, y: 0, width: 400, height: 100), axRole: "AXScrollArea", axActions: []),
            cuTestNode(3, depth: 2, frame: CGRect(x: 0, y: 20, width: 100, height: 20), axRole: "AXRow", axActions: []),
            cuTestNode(4, depth: 2, frame: CGRect(x: 0, y: 220, width: 100, height: 20), axRole: "AXRow", axActions: []),
            cuTestNode(5, depth: 1, frame: CGRect(x: 0, y: 300, width: 60, height: 20)),
        ], window: window, scale: 1)
        XCTAssertEqual(marks.map(\.id), [3, 5])
    }
}

final class ComputerMarkdownLinkTests: XCTestCase {
    func testBracketsThatAreNotLinksStayAsText() {
        XCTAssertEqual(cuInlineMarkdown("[a] x [b](u)"), #"[a] x <a href="u">b</a>"#)
        XCTAssertEqual(cuInlineMarkdown("[see [1]](https://e.com/a_(b))"), #"<a href="https://e.com/a_(b)">see [1]</a>"#)
    }

    func testScriptAndDataLinksKeepOnlyTheirText() {
        XCTAssertEqual(cuInlineMarkdown("[click](javascript:alert(1))"), "click")
        XCTAssertEqual(cuInlineMarkdown("[img]( DATA:text/html;base64,xx)"), "img")
        XCTAssertEqual(cuInlineMarkdown("[ok](mailto:a@b.c)"), #"<a href="mailto:a@b.c">ok</a>"#)
    }
}
