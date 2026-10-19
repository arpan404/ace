import Testing
import Foundation
@testable import Ace

@Suite struct TerminalBufferTests {
    @Test func terminalControlsRenderLinesWithoutLeakingEscapeSequences() {
        var terminal = TerminalBuffer()
        terminal.feed("\u{1b}[32mready\u{1b}[0m\r\ncount: 1")
        terminal.feed("\rcount: 2\u{1b}[K\r\n")
        #expect(terminal.text == "ready\ncount: 2\n")
        terminal.feed("secret\u{1b}]0;private title")
        terminal.feed("\u{7}\rpublic\u{1b}[K")
        #expect(terminal.text == "ready\ncount: 2\npublic")
    }
    @Test func splitEscapeSequencesAndCursorMovementPreserveTheScreen() {
        var terminal = TerminalBuffer()
        terminal.feed("abc\r\ndef\u{1b}[")
        terminal.feed("1A\rxy\u{1b}[K")
        #expect(terminal.text == "xy\ndef")
    }
    @Test func scrollbackStaysBoundedAndCanBeCleared() {
        var terminal = TerminalBuffer(columns: 80, rows: 2, limit: 3)
        terminal.feed("1\r\n2\r\n3\r\n4")
        #expect(terminal.text == "2\n3\n4")
        terminal.feed("\u{1b}[2Jdone")
        #expect(terminal.text == "done")
    }
    @Test func extremeCursorParametersAndCombiningSequencesStayBoundedAndDoNotStopLaterOutput() {
        var terminal = TerminalBuffer()
        terminal.feed("A\u{1b}[9223372036854775807CB\r\n")
        terminal.feed("e" + String(repeating: "\u{301}", count: 1000) + "done")
        #expect(terminal.text.hasSuffix("�done"))
        #expect(terminal.text.utf16.count < 100)
    }
}
@Suite @MainActor struct TerminalDeliveryTests {
    @Test func reconnectReplayAppendsEachByteOnlyOnceAndOldStreamsCannotChangeTheSurface() throws {
        let model = TerminalScreenModel(); model.start("one")
        func frame(_ id: String, _ offset: Int, _ end: Int, _ data: String) throws -> TerminalOutputPatch {
            let raw: [String: Any] = ["id": id, "event": ["type": "data", "offset": offset, "endOffset": end, "data": data]]
            return try JSONDecoder().decode(TerminalOutputPatch.self, from: JSONSerialization.data(withJSONObject: raw))
        }
        #expect(model.receive(try frame("one", 0, 3, "abc")) == 3)
        #expect(model.receive(try frame("one", 0, 3, "abc")) == 3)
        #expect(model.receive(try frame("one", 1, 5, "bcde")) == 5)
        #expect(model.text == "abcde")
        model.start("two")
        #expect(model.receive(try frame("one", 5, 8, "old")) == nil)
        #expect(model.text.isEmpty)
    }
    @Test func interruptedOscBeforeResyncStillShowsLaterReplayOnce() throws {
        let model = TerminalScreenModel(); model.start("osc")
        func dataFrame(_ offset: Int, _ data: String, truncatedBefore: Bool = false) throws -> TerminalOutputPatch {
            let raw: [String: Any] = ["id": "osc", "event": ["type": "data", "offset": offset, "endOffset": offset + data.utf8.count, "data": data, "truncatedBefore": truncatedBefore]]
            return try JSONDecoder().decode(TerminalOutputPatch.self, from: JSONSerialization.data(withJSONObject: raw))
        }
        func resyncFrame(_ oldest: Int, _ next: Int) throws -> TerminalOutputPatch {
            let raw: [String: Any] = ["id": "osc", "event": ["type": "resync", "oldestOffset": oldest, "nextOffset": next]]
            return try JSONDecoder().decode(TerminalOutputPatch.self, from: JSONSerialization.data(withJSONObject: raw))
        }
        let partial = "hi\u{1b}]0;partial"
        #expect(model.receive(try dataFrame(0, partial)) == partial.utf8.count)
        #expect(model.text == "hi")
        let oldest = partial.utf8.count + 7
        #expect(model.receive(try resyncFrame(oldest, oldest)) == oldest)
        #expect(model.text.contains("[Earlier output unavailable]"))
        #expect(model.receive(try dataFrame(oldest, "ok")) == oldest + 2)
        #expect(model.text.contains("ok"))
        #expect(model.text.contains("[Earlier output unavailable]"))
        let gapsBefore = model.text.components(separatedBy: "[Earlier output unavailable]").count - 1
        #expect(model.receive(try resyncFrame(oldest, oldest)) == oldest + 2)
        #expect(model.text.components(separatedBy: "[Earlier output unavailable]").count - 1 == gapsBefore)
    }
    @Test func interruptedCsiBeforeTruncatedReplayStillShowsGapAndLaterOutput() throws {
        let model = TerminalScreenModel(); model.start("csi")
        func dataFrame(_ offset: Int, _ data: String, truncatedBefore: Bool = false) throws -> TerminalOutputPatch {
            let raw: [String: Any] = ["id": "csi", "event": ["type": "data", "offset": offset, "endOffset": offset + data.utf8.count, "data": data, "truncatedBefore": truncatedBefore]]
            return try JSONDecoder().decode(TerminalOutputPatch.self, from: JSONSerialization.data(withJSONObject: raw))
        }
        let partial = "a\u{1b}[1;"
        #expect(model.receive(try dataFrame(0, partial)) == partial.utf8.count)
        #expect(model.text == "a")
        let replay = "recovered"
        let start = partial.utf8.count + 3
        #expect(model.receive(try dataFrame(start, replay, truncatedBefore: true)) == start + replay.utf8.count)
        #expect(model.text.contains("[Earlier output unavailable]"))
        #expect(model.text.contains(replay))
    }
    @Test func overflowGapKeepsMonotonicOffsetsAndDedupesOverlap() throws {
        let model = TerminalScreenModel(); model.start("gap")
        func dataFrame(_ offset: Int, _ data: String, truncatedBefore: Bool = false) throws -> TerminalOutputPatch {
            let raw: [String: Any] = ["id": "gap", "event": ["type": "data", "offset": offset, "endOffset": offset + data.utf8.count, "data": data, "truncatedBefore": truncatedBefore]]
            return try JSONDecoder().decode(TerminalOutputPatch.self, from: JSONSerialization.data(withJSONObject: raw))
        }
        #expect(model.receive(try dataFrame(0, "abc")) == 3)
        #expect(model.text == "abc")
        #expect(model.receive(try dataFrame(10, "def")) == 13)
        #expect(model.text.contains("[Earlier output unavailable]"))
        #expect(model.text.contains("def"))
        #expect(model.receive(try dataFrame(0, "abc")) == 13)
        #expect(model.receive(try dataFrame(11, "efghi")) == 16)
        #expect(model.text.contains("ghi"))
        #expect(model.offset == 16)
    }
}
