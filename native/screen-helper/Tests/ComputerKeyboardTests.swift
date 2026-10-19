import XCTest
import CoreGraphics
@testable import ScreenHelper

/// Keyboard layouts are supplied, never read from the machine running the tests.
private let us: CUKeyLayout = {
    var entries: [(CUKeyStroke, String)] = []
    for code in CGKeyCode(0)..<128 {
        if let plain = CUKeyLayout.ansi.text(code) { entries.append((CUKeyStroke(code), plain)) }
        if let shifted = CUKeyLayout.ansi.text(code, shift: true) { entries.append((CUKeyStroke(code, shift: true), shifted)) }
    }
    entries.append((CUKeyStroke(14, option: true), "´"))
    entries.append((CUKeyStroke(19, option: true), "™"))
    return CUKeyLayout(entries)
}()

/// French AZERTY: letters A/Q and Z/W swap places; digits need Shift.
private let azerty = CUKeyLayout([
    (CUKeyStroke(12), "a"), (CUKeyStroke(12, shift: true), "A"), (CUKeyStroke(0), "q"), (CUKeyStroke(0, shift: true), "Q"),
    (CUKeyStroke(13), "z"), (CUKeyStroke(6), "w"), (CUKeyStroke(8), "c"), (CUKeyStroke(9), "v"),
    (CUKeyStroke(18), "&"), (CUKeyStroke(18, shift: true), "1"), (CUKeyStroke(19), "é"), (CUKeyStroke(19, shift: true), "2"),
])

final class ComputerChordTests: XCTestCase {
    func testChordsCarryModifiersAndTheKeyTheyName() throws {
        let new = try cuParseChord("cmd+shift+n", layout: us)
        XCTAssertEqual(new.code, 45)
        XCTAssertEqual(new.flags, [.maskCommand, .maskShift])
        XCTAssertEqual(try cuParseChord("Return", layout: us).text, "\r")
        XCTAssertEqual(try cuParseChord("ctrl+alt+Down", layout: us).code, 125)
    }

    func testShiftedChordsTypeWhatShiftProduces() throws {
        XCTAssertEqual(try cuParseChord("shift+a", layout: us).text, "A")
        XCTAssertEqual(try cuParseChord("shift+1", layout: us).text, "!")
        let capital = try cuParseChord("A", layout: us)
        XCTAssertEqual(capital.code, 0)
        XCTAssertEqual(capital.flags, .maskShift)
        XCTAssertEqual(capital.text, "A")
        XCTAssertEqual(try cuParseChord("*", layout: us).flags, .maskShift)
    }

    func testOptionChordsTypeTheLayoutsOptionCharacter() throws {
        let acute = try cuParseChord("alt+e", layout: us)
        XCTAssertEqual(acute.text, "´")
        XCTAssertEqual(acute.flags, .maskAlternate)
        XCTAssertEqual(try cuParseChord("option+2", layout: us).text, "™")
    }

    func testShiftTabSendsBackTab() throws {
        let back = try cuParseChord("shift+Tab", layout: us)
        XCTAssertEqual(back.code, 48)
        XCTAssertEqual(back.text, "\u{19}")
        XCTAssertEqual(try cuParseChord("Tab", layout: us).text, "\t")
    }

    func testShortcutsPressTheKeyThatTypesTheLetterOnTheCurrentLayout() throws {
        let selectAll = try cuParseChord("ctrl+a", layout: azerty)
        XCTAssertEqual(selectAll.code, 12)
        XCTAssertEqual(selectAll.flags, .maskControl)
        XCTAssertEqual(try cuParseChord("cmd+q", layout: azerty).code, 0)
        XCTAssertEqual(try cuParseChord("1", layout: azerty).flags, .maskShift)
    }

    func testCapitalLettersInShortcutsNameTheKeyWithoutShift() throws {
        let save = try cuParseChord("cmd+S", layout: us)
        XCTAssertEqual(save.flags, .maskCommand)
        XCTAssertEqual(save.keyChar, "s")
    }

    func testCharactersNoKeyTypesArePostedOnANeutralKey() throws {
        let accented = try cuParseChord("é", layout: us)
        XCTAssertEqual(accented.code, cuNeutralKeyCode)
        XCTAssertNotEqual(accented.code, 0)
        XCTAssertEqual(accented.text, "é")
        XCTAssertEqual(try cuParseChord("é", layout: azerty).code, 19)
    }

    func testUnknownKeysExplainWhatIsAccepted() {
        XCTAssertThrowsError(try cuParseChord("hyper+k", layout: us)) { error in
            XCTAssertTrue((error as? CUError)?.message.contains("cmd, shift, alt") == true)
        }
        XCTAssertThrowsError(try cuParseChord("Launchpad", layout: us)) { error in
            XCTAssertTrue((error as? CUError)?.message.contains("Return, Tab, Escape") == true)
        }
    }

    func testOnlyPrintableNonShortcutKeysCountAsTyping() throws {
        XCTAssertTrue(try cuParseChord("a", layout: us).typesText)
        XCTAssertTrue(try cuParseChord("space", layout: us).typesText)
        XCTAssertFalse(try cuParseChord("cmd+a", layout: us).typesText)
        XCTAssertFalse(try cuParseChord("Return", layout: us).typesText)
        XCTAssertFalse(try cuParseChord("Down", layout: us).typesText)
    }
}

final class ComputerShortcutTests: XCTestCase {
    private func matches(_ chord: String, char: String?, key: Int? = nil, modifiers: Int, layout: CUKeyLayout = us) throws -> Bool {
        cuShortcutMatches(itemChar: char, itemVirtualKey: key, itemModifiers: modifiers, chord: try cuParseChord(chord, layout: layout))
    }

    func testLetterShortcutsMatchCaseInsensitivelyWithExactModifiers() throws {
        XCTAssertTrue(try matches("cmd+v", char: "V", modifiers: 0))
        XCTAssertTrue(try matches("cmd+shift+z", char: "Z", modifiers: 1))
        XCTAssertFalse(try matches("cmd+shift+z", char: "Z", modifiers: 0))
        XCTAssertFalse(try matches("cmd+z", char: "Z", modifiers: 1))
    }

    func testSymbolShortcutsThatNeedShiftMatchTheirMenuItem() throws {
        XCTAssertTrue(try matches("cmd++", char: "+", modifiers: 0))
        XCTAssertTrue(try matches("cmd+plus", char: "+", modifiers: 0))
        XCTAssertTrue(try matches("cmd+shift+=", char: "+", modifiers: 0))
        XCTAssertTrue(try matches("cmd+?", char: "?", modifiers: 0))
        XCTAssertTrue(try matches("cmd+{", char: "{", modifiers: 0))
        XCTAssertFalse(try matches("cmd+=", char: "+", modifiers: 0))
        XCTAssertFalse(try matches("cmd+alt+?", char: "?", modifiers: 0))
    }

    func testShortcutsMatchOnNonUSLayouts() throws {
        XCTAssertTrue(try matches("cmd+a", char: "A", modifiers: 0, layout: azerty))
        XCTAssertFalse(try matches("cmd+q", char: "A", modifiers: 0, layout: azerty))
    }

    func testArrowAndDeleteShortcutsMatchByKey() throws {
        XCTAssertTrue(try matches("cmd+Left", char: "\u{F702}", modifiers: 0))
        XCTAssertTrue(try matches("cmd+Backspace", char: "\u{8}", modifiers: 0))
        XCTAssertFalse(try matches("cmd+Right", char: "\u{F702}", modifiers: 0))
        XCTAssertTrue(try matches("cmd+Down", char: nil, key: 125, modifiers: 0))
    }

    func testControlShortcutsWithoutCommandUseTheNoCommandBit() throws {
        XCTAssertTrue(try matches("ctrl+x", char: "X", modifiers: 12))
        XCTAssertFalse(try matches("ctrl+x", char: "X", modifiers: 4))
    }

    func testPlainKeysNeverMapToMenus() throws {
        XCTAssertFalse(try matches("shift+Tab", char: nil, key: 48, modifiers: 1))
        XCTAssertFalse(try matches("x", char: "X", modifiers: 8))
    }

    func testOnlyPlainCommandLettersAreEmulatedTextCommands() throws {
        XCTAssertEqual(cuTextCommand(try cuParseChord("cmd+a", layout: us)), .selectAll)
        XCTAssertEqual(cuTextCommand(try cuParseChord("cmd+v", layout: us)), .paste)
        XCTAssertEqual(cuTextCommand(try cuParseChord("cmd+a", layout: azerty)), .selectAll)
        XCTAssertNil(cuTextCommand(try cuParseChord("cmd+shift+v", layout: us)))
        XCTAssertNil(cuTextCommand(try cuParseChord("cmd+n", layout: us)))
    }
}

final class ComputerTypingTests: XCTestCase {
    func testTypingPostsChunksAndKeysForLineBreaksAndTabs() {
        XCTAssertEqual(cuTypingPlan("ab\ncd\te", chunk: 20), [.text("ab"), .key(36, "\r"), .text("cd"), .key(48, "\t"), .text("e")])
        let long = String(repeating: "x", count: 45)
        XCTAssertEqual(cuTypingPlan(long, chunk: 20).map { step -> Int in if case .text(let run) = step { return run.count } else { return -1 } }, [20, 20, 5])
    }

    func testChunksNeverSplitACharacter() {
        let family = "👨‍👩‍👧‍👦"
        let plan = cuTypingPlan("abcdefghijklmnopqr" + family, chunk: 20)
        XCTAssertEqual(plan, [.text("abcdefghijklmnopqr"), .text(family)])
        XCTAssertEqual(cuTypingPlan("ab", chunk: 1), [.text("a"), .text("b")])
    }

    func testReplacingASameLengthSelectionCountsAsAChange() {
        let before = CUTextState(count: 10, selection: NSRange(location: 2, length: 3))
        let after = CUTextState(count: 10, selection: NSRange(location: 5, length: 0))
        XCTAssertEqual(cuInsertOutcome(accepted: true, before: before, after: after), .changed)
    }

    func testOnlyAnObservedNoChangeAllowsASecondInsertionPath() {
        let state = CUTextState(count: 4, selection: NSRange(location: 4, length: 0))
        XCTAssertEqual(cuInsertOutcome(accepted: true, before: state, after: state), .ignored)
        XCTAssertEqual(cuInsertOutcome(accepted: true, before: CUTextState(), after: CUTextState()), .unverified)
        XCTAssertEqual(cuInsertOutcome(accepted: false, before: state, after: state), .refused)
    }

    func testLandedTextIsMeasuredByTheCaretWhenASelectionWasReplaced() {
        let before = CUTextState(count: 10, selection: NSRange(location: 5, length: 3))
        let after = CUTextState(count: 9, selection: NSRange(location: 7, length: 0))
        XCTAssertEqual(cuLandedUnits(before: before, after: after), 2)
        XCTAssertEqual(cuLandedUnits(before: CUTextState(count: 3), after: CUTextState(count: 23)), 20)
        XCTAssertNil(cuLandedUnits(before: CUTextState(), after: CUTextState()))
    }
}
