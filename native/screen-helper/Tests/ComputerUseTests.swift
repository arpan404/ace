import XCTest
import CoreGraphics
@testable import ScreenHelper

final class ComputerKeyTests: XCTestCase {
    func testChordsCarryModifiersAndTheKeyTheyName() throws {
        XCTAssertEqual(try cuParseChord("cmd+shift+n"), CUChord(code: 45, flags: [.maskCommand, .maskShift], text: "n"))
        XCTAssertEqual(try cuParseChord("Return"), CUChord(code: 36, flags: [], text: "\r"))
        XCTAssertEqual(try cuParseChord("ctrl+alt+Down"), CUChord(code: 125, flags: [.maskControl, .maskAlternate], text: nil))
        XCTAssertEqual(try cuParseChord("cmd++"), CUChord(code: 24, flags: [.maskCommand, .maskShift], text: "+"))
    }

    func testShiftedSymbolsAndCapitalsPressShift() throws {
        XCTAssertEqual(try cuParseChord("*").flags, .maskShift)
        XCTAssertEqual(try cuParseChord("A"), CUChord(code: 0, flags: .maskShift, text: "A"))
    }

    func testCharactersOutsideTheLayoutAreTypedAsUnicode() throws {
        XCTAssertEqual(try cuParseChord("é"), CUChord(code: 0, flags: [], text: "é"))
    }

    func testUnknownKeysExplainWhatIsAccepted() {
        XCTAssertThrowsError(try cuParseChord("hyper+k")) { error in
            XCTAssertTrue((error as? CUError)?.message.contains("cmd, shift, alt") == true)
        }
        XCTAssertThrowsError(try cuParseChord("Launchpad")) { error in
            XCTAssertTrue((error as? CUError)?.message.contains("Return, Tab, Escape") == true)
        }
    }

    func testTypedNewlinesAndTabsBecomeKeys() {
        XCTAssertEqual(cuTypingSteps("a\nb\t"), [.character("a"), .key(36), .character("b"), .key(48)])
    }
}

final class ComputerShortcutTests: XCTestCase {
    func testMenuShortcutsMatchCaseInsensitivelyWithExactModifiers() throws {
        let paste = try cuParseChord("cmd+v")
        XCTAssertTrue(cuShortcutMatches(itemChar: "V", itemVirtualKey: nil, itemModifiers: 0, chord: paste, mask: 0))
        let redo = try cuParseChord("cmd+shift+z")
        XCTAssertTrue(cuShortcutMatches(itemChar: "Z", itemVirtualKey: nil, itemModifiers: 1, chord: redo, mask: cuMenuModifierMask(redo.flags) ?? -1))
        XCTAssertFalse(cuShortcutMatches(itemChar: "Z", itemVirtualKey: nil, itemModifiers: 0, chord: redo, mask: cuMenuModifierMask(redo.flags) ?? -1))
    }

    func testShortcutsWithoutCommandNeverMapToMenus() throws {
        XCTAssertNil(cuMenuModifierMask(try cuParseChord("shift+Tab").flags))
    }

    func testOnlyPlainCommandLettersAreEmulatedTextCommands() throws {
        XCTAssertEqual(cuTextCommand(try cuParseChord("cmd+a")), .selectAll)
        XCTAssertEqual(cuTextCommand(try cuParseChord("cmd+v")), .paste)
        XCTAssertNil(cuTextCommand(try cuParseChord("cmd+shift+v")))
        XCTAssertNil(cuTextCommand(try cuParseChord("cmd+n")))
    }
}

final class ComputerGuardTests: XCTestCase {
    private func facts(locked: Bool = false, front: Bool = false, idle: Double = 60, stop: Bool = false) -> CUGuardFacts {
        CUGuardFacts(locked: locked, appFrontmost: front, secondsSinceHumanInput: idle, stopRequested: stop)
    }

    func testAgentWorksInBackgroundAppsWhileThePersonTypesElsewhere() {
        XCTAssertNoThrow(try cuGuard(facts(front: false, idle: 0.1), app: "Notes"))
    }

    func testAgentWaitsWhileThePersonIsUsingTheSameApp() {
        XCTAssertThrowsError(try cuGuard(facts(front: true, idle: 0.3), app: "Notes")) { error in
            XCTAssertEqual((error as? CUError)?.code, "person_active")
        }
        XCTAssertNoThrow(try cuGuard(facts(front: true, idle: 5), app: "Notes"))
    }

    func testEscapeAndALockedScreenStopTheAgent() {
        XCTAssertEqual(Self.code { try cuGuard(self.facts(stop: true), app: "Notes") }, "stopped_by_person")
        XCTAssertEqual(Self.code { try cuGuard(self.facts(locked: true), app: "Notes") }, "screen_locked")
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
        func node(_ id: Int, _ frame: CGRect, role: String = "AXButton", actions: [String] = ["AXPress"]) -> CUNode {
            CUNode(id: id, depth: 1, role: "button", flags: [], name: nil, value: nil, detail: nil, placeholder: nil, url: nil, actions: [], frame: frame, axActions: actions, axRole: role)
        }
        let window = CGRect(x: 100, y: 100, width: 400, height: 300)
        let marks = cuMarks(nodes: [
            node(1, window, role: "AXWindow"),
            node(2, CGRect(x: 110, y: 120, width: 40, height: 20)),
            node(3, CGRect(x: 110, y: 160, width: 40, height: 20), role: "AXStaticText", actions: []),
            node(4, CGRect(x: 900, y: 900, width: 40, height: 20)),
        ], window: window, scale: 2)
        XCTAssertEqual(marks, [CUMark(id: 2, rect: CGRect(x: 20, y: 40, width: 80, height: 40))])
    }
}
