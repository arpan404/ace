import Testing
import Foundation
@testable import Ace

/// Feeds output to a fresh screen and answers it, as the parsing queue would.
private func screen(_ output: String..., columns: Int = 20, rows: Int = 5, scrollback: Int = 100) -> TerminalScreen {
    var parser = TerminalParser()
    var screen = TerminalScreen(columns: columns, rows: rows, scrollback: scrollback)
    for piece in output { parser.feed(piece, into: &screen) }
    return screen
}
private func rows(_ screen: TerminalScreen) -> [String] { screen.lines.map(\.text) }

@Suite struct TerminalEmulatorTests {
    @Test func coloursAndStylesLandOnTheCellsTheyWereSetFor() {
        let s = screen("\u{1b}[31mr\u{1b}[0m \u{1b}[38;5;208mo\u{1b}[38;2;10;20;30mt\u{1b}[1;4;7mB\u{1b}[22;24;27mn\u{1b}[44;97mx")
        #expect(s.cell(row: 0, column: 0).style.foreground == .indexed(1))
        #expect(s.cell(row: 0, column: 1).style == .plain)
        #expect(s.cell(row: 0, column: 2).style.foreground == .indexed(208))
        #expect(s.cell(row: 0, column: 3).style.foreground == .rgb(10, 20, 30))
        #expect(s.cell(row: 0, column: 4).style.flags == [.bold, .underline, .inverse])
        #expect(s.cell(row: 0, column: 5).style.flags.isEmpty)
        #expect(s.cell(row: 0, column: 6).style.background == .indexed(4))
        #expect(s.cell(row: 0, column: 6).style.foreground == .indexed(15))
    }

    @Test func colonSeparatedColoursAreReadLikeSemicolonOnes() {
        let s = screen("\u{1b}[38:2::1:2:3m\u{1b}[48:5:17ma\u{1b}[38:2:4:5:6mb")
        #expect(s.cell(row: 0, column: 0).style.foreground == .rgb(1, 2, 3))
        #expect(s.cell(row: 0, column: 0).style.background == .indexed(17))
        #expect(s.cell(row: 0, column: 1).style.foreground == .rgb(4, 5, 6))
    }

    @Test func cursorAddressingAndErasingDrawAFullScreenLayout() {
        let s = screen("\u{1b}[2J\u{1b}[1;1Htop\u{1b}[3;5Hmid\u{1b}[5;18Hend\u{1b}[1;2H\u{1b}[K")
        #expect(rows(s) == ["t", "", "    mid", "", "                 end"])
        #expect(s.cursorRow == 0 && s.cursorColumn == 1)
    }

    @Test func aFullRowHoldsTheCursorAtTheEdgeUntilTheNextCharacterWraps() {
        var s = screen("abcde", columns: 5)
        #expect(s.cursorColumn == 4 && s.pendingWrap)
        #expect(rows(s)[0] == "abcde")
        var parser = TerminalParser()
        parser.feed("\rX", into: &s)
        #expect(rows(s)[0] == "Xbcde")
        parser.feed("\u{1b}[1;5Hef", into: &s)
        #expect(rows(s)[0] == "Xbcde" && rows(s)[1] == "f")
        #expect(s.lines[0].wrapped)
        let off = screen("\u{1b}[?7labcdefg", columns: 5)
        #expect(rows(off) == ["abcdg", "", "", "", ""])
    }

    @Test func scrollRegionsMoveOnlyTheirRowsAndKeepHistoryClean() {
        let s = screen("1\r\n2\r\n3\r\n4\r\n5\u{1b}[2;4r\u{1b}[4;1H\nX", rows: 5)
        #expect(rows(s) == ["1", "3", "4", "X", "5"])
        #expect(s.historyCount == 0)
        let reverse = screen("1\r\n2\r\n3\u{1b}[1;3r\u{1b}[1;1H\u{1b}MY", rows: 3)
        #expect(rows(reverse) == ["Y", "1", "2"])
    }

    @Test func fullScreenProgramsUseTheAlternateScreenAndLeaveTheShellAsItWas() {
        var s = screen("$ vim\r\n", rows: 3)
        var parser = TerminalParser()
        parser.feed("\u{1b}[?1049h\u{1b}[H~\r\n~\r\n~ file", into: &s)
        #expect(s.usingAlternate && s.historyCount == 0)
        #expect(rows(s) == ["~", "~", "~ file"])
        parser.feed("\r\n\r\n\r\n", into: &s) // scrolling inside the program keeps no history
        parser.feed("\u{1b}[?1049l", into: &s)
        #expect(!s.usingAlternate)
        #expect(rows(s) == ["$ vim", "", ""])
        #expect(s.cursorRow == 1 && s.cursorColumn == 0)
        #expect(s.historyCount == 0)
    }

    @Test func linesScrolledOffTheTopAreKeptInBoundedHistory() {
        let output = (1...10).map { "line \($0)" }.joined(separator: "\r\n")
        let s = screen(output, rows: 3, scrollback: 4)
        #expect(s.historyCount == 4)
        #expect(s.text == (4...10).map { "line \($0)" }.joined(separator: "\n"))
        let cleared = screen(output, "\u{1b}[3J", rows: 3)
        #expect(cleared.historyCount == 0)
    }

    @Test func wideCharactersTakeTwoCellsAndOverwritingHalfClearsTheOther() {
        var s = screen("a漢b😀")
        #expect(s.cell(row: 0, column: 1).style.flags.contains(.wide))
        #expect(s.cell(row: 0, column: 2).style.flags.contains(.wideTrail))
        #expect(s.cell(row: 0, column: 3).scalar == UInt32(("b" as Unicode.Scalar).value))
        #expect(s.cell(row: 0, column: 4).style.flags.contains(.wide))
        #expect(s.cursorColumn == 6)
        var parser = TerminalParser()
        parser.feed("\u{1b}[1;3Hx", into: &s)
        #expect(rows(s)[0] == "a xb😀")
        let edge = screen("abcd漢", columns: 5)
        #expect(rows(edge) == ["abcd", "漢", "", "", ""])
    }

    @Test func combiningMarksJoinTheCharacterBeforeThem() {
        let s = screen("e\u{301}x")
        #expect(rows(s)[0] == "e\u{301}x")
        #expect(s.cursorColumn == 2)
        let bounded = screen("e" + String(repeating: "\u{301}", count: 1000) + "done")
        #expect(rows(bounded)[0].unicodeScalars.count < 30)
        #expect(rows(bounded)[0].hasSuffix("done"))
    }

    @Test func insertingAndDeletingCharactersAndLinesShiftsTheRest() {
        #expect(rows(screen("abcdef\r\u{1b}[2C\u{1b}[2@XY"))[0] == "abXYcdef")
        #expect(rows(screen("abcdef\r\u{1b}[1C\u{1b}[3P"))[0] == "aef")
        #expect(rows(screen("abcdef\r\u{1b}[2C\u{1b}[2X"))[0] == "ab  ef")
        #expect(rows(screen("1\r\n2\r\n3\u{1b}[2;1H\u{1b}[L", rows: 3)) == ["1", "", "2"])
        #expect(rows(screen("1\r\n2\r\n3\u{1b}[1;1H\u{1b}[M", rows: 3)) == ["2", "3", ""])
        #expect(rows(screen("ab\u{1b}[3b"))[0] == "abbbb")
    }

    @Test func lineDrawingCharactersComeFromTheGraphicsSet() {
        #expect(rows(screen("\u{1b}(0lqqk\u{1b}(B x"))[0] == "┌──┐ x")
        #expect(rows(screen("\u{1b})0a\u{0e}x\u{0f}x"))[0] == "a│x")
    }

    @Test func eraseUsesTheCurrentBackground() {
        let s = screen("\u{1b}[41m\u{1b}[2K\u{1b}[0mok")
        #expect(s.cell(row: 0, column: 10).style.background == .indexed(1))
        #expect(s.cell(row: 0, column: 0).style.background == .standard)
    }

    @Test func tabStopsAdvanceToTheNextEighthColumnAndCanBeSet() {
        #expect(rows(screen("a\tb"))[0] == "a       b")
        #expect(rows(screen("\u{1b}[3G\u{1b}H\u{1b}[1G\tx"))[0] == "  x")
    }

    @Test func deviceReportsAnswerWithTheCursorAndTheTerminalKind() {
        let s = screen("ab\r\nc\u{1b}[6n\u{1b}[c")
        #expect(s.replies == "\u{1b}[2;2R\u{1b}[?62;22c")
    }

    @Test func sequencesSplitAcrossOutputChunksStillApply() {
        let s = screen("\u{1b}[3", "1mX\u{1b}", "[0mY\u{1b}]0;ti", "tle\u{07}Z")
        #expect(rows(s)[0] == "XYZ")
        #expect(s.cell(row: 0, column: 0).style.foreground == .indexed(1))
        #expect(s.cell(row: 0, column: 1).style == .plain)
        #expect(s.title == "title")
    }

    @Test func stringsAndPrivateSequencesNeverPrint() {
        let s = screen("a\u{1b}P1;2qpayload\u{1b}\\b\u{1b}]8;;https://x\u{1b}\\c\u{1b}[?2004hd\u{1b}_apc\u{07}e")
        #expect(rows(s)[0] == "abcde")
        #expect(s.modes.bracketedPaste)
    }

    @Test func cursorKeyModeFollowsTheProgramAndResetsWithTheTerminal() {
        #expect(screen("\u{1b}[?1h").modes.applicationCursor)
        #expect(!screen("\u{1b}[?1h\u{1b}c").modes.applicationCursor)
        #expect(!screen("\u{1b}[?25;1l").modes.applicationCursor)
        #expect(!screen("\u{1b}[?25l").modes.cursorVisible)
    }

    @Test func extremeParametersStayInsideTheScreen() {
        let s = screen("A\u{1b}[99999999999999CB\u{1b}[99999;99999HC\u{1b}[99999@")
        #expect(s.cursorRow == 4 && s.cursorColumn <= 19)
        #expect(rows(s)[0].hasPrefix("A") && rows(s)[0].hasSuffix("B"))
    }

    @Test func resizingKeepsTheNewestRowsAndBringsHistoryBack() {
        var s = screen("1\r\n2\r\n3\r\n4\r\n5", rows: 5)
        s.resize(columns: 20, rows: 3)
        #expect(rows(s) == ["3", "4", "5"] && s.historyCount == 2)
        #expect(s.cursorRow == 2)
        s.resize(columns: 20, rows: 5)
        #expect(rows(s) == ["1", "2", "3", "4", "5"] && s.historyCount == 0)
        s.resize(columns: 3, rows: 5)
        #expect(s.lines.allSatisfy { $0.cells.count == 3 })
    }

    @Test func clearingKeepsThePromptLineAndDropsHistory() {
        var s = screen("1\r\n2\r\n3\r\n4\r\n$ ", rows: 3)
        s.clearHistory()
        #expect(s.historyCount == 0)
        #expect(rows(s) == ["$", "", ""])
        #expect(s.cursorRow == 0 && s.cursorColumn == 2)
    }

    @Test func findLocatesMatchesInHistoryAndScreenByColumn() {
        let s = screen("error one\r\nok\r\nan ERROR 漢error\r\n", rows: 2)
        let found = TerminalFind.matches(of: "error", in: s)
        #expect(found.count == 3)
        #expect(found.map(\.column) == [0, 3, 11])
        #expect(found.allSatisfy { $0.length == 5 })
    }
}

@Suite @MainActor struct TerminalDeliveryTests {
    private func frame(_ id: String, _ offset: Int, _ data: String, truncatedBefore: Bool = false) throws -> TerminalOutputPatch {
        let raw: [String: Any] = ["id": id, "event": ["type": "data", "offset": offset, "endOffset": offset + data.utf8.count, "data": data, "truncatedBefore": truncatedBefore]]
        return try JSONDecoder().decode(TerminalOutputPatch.self, from: JSONSerialization.data(withJSONObject: raw))
    }
    private func resync(_ id: String, _ oldest: Int) throws -> TerminalOutputPatch {
        let raw: [String: Any] = ["id": id, "event": ["type": "resync", "oldestOffset": oldest, "nextOffset": oldest]]
        return try JSONDecoder().decode(TerminalOutputPatch.self, from: JSONSerialization.data(withJSONObject: raw))
    }

    @Test func reconnectReplayAppendsEachByteOnlyOnceAndOldStreamsCannotChangeTheSurface() throws {
        let model = TerminalScreenModel(); model.start("one")
        #expect(model.receive(try frame("one", 0, "abc")) == 3)
        #expect(model.receive(try frame("one", 0, "abc")) == 3)
        #expect(model.receive(try frame("one", 1, "bcde")) == 5)
        model.settle()
        #expect(model.text == "abcde")
        model.start("two")
        #expect(model.receive(try frame("one", 5, "old")) == nil)
        model.settle()
        #expect(model.text.isEmpty)
    }

    @Test func aGapIsMarkedOnceAndAnInterruptedSequenceCannotSwallowLaterOutput() throws {
        let model = TerminalScreenModel(); model.start("gap")
        let partial = "hi\u{1b}]0;partial"
        #expect(model.receive(try frame("gap", 0, partial)) == partial.utf8.count)
        let oldest = partial.utf8.count + 7
        #expect(model.receive(try resync("gap", oldest)) == oldest)
        #expect(model.receive(try frame("gap", oldest, "ok")) == oldest + 2)
        #expect(model.receive(try resync("gap", oldest)) == oldest + 2)
        let cut = "\u{1b}[1;"
        #expect(model.receive(try frame("gap", oldest + 2, cut)) == oldest + 2 + cut.utf8.count)
        #expect(model.receive(try frame("gap", oldest + 20, "recovered", truncatedBefore: true)) == oldest + 29)
        model.settle()
        let text = model.text
        #expect(text.hasPrefix("hi"))
        #expect(text.components(separatedBy: "[Earlier output unavailable]").count - 1 == 2)
        #expect(text.contains("ok") && text.hasSuffix("recovered"))
    }

    @Test func creditFollowsParsingWithTheAcknowledgedOffset() async throws {
        let model = TerminalScreenModel(); model.start("credit")
        let credited: Int = await withCheckedContinuation { done in
            model.receive(try! frame("credit", 0, "hello")) { offset in done.resume(returning: offset) }
        }
        #expect(credited == 5)
        #expect(model.text == "hello")
    }

    @Test func programsAskingForTheCursorGetTheirReplySent() async throws {
        let model = TerminalScreenModel(); model.start("reply")
        let reply: String = await withCheckedContinuation { done in
            model.onReply = { done.resume(returning: $0) }
            model.receive(try! frame("reply", 0, "ab\u{1b}[6n"))
        }
        #expect(reply == "\u{1b}[1;3R")
    }
}
