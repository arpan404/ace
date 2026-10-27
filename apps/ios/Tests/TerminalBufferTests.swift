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

/// Emulator behaviour that isn't a grid after input: clearing (an app action) and Find. Grid
/// behaviour is in the shared cases (`TerminalCaseTests`, `fixtures/terminal-emulator`).
@Suite struct TerminalEmulatorTests {
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
