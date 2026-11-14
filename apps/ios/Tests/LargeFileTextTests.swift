import Testing
@testable import Ace

/// A file too large to show whole, as its pages build it: each part gives back exactly the text
/// it was read as (so a save covers exactly its bytes), line numbers run on across parts, and
/// find steps through matches, reading on before it wraps.
@Suite struct LargeFileTextTests {
    private func page(_ text: String, at offset: Int, size: Int, done: Bool = false) -> FilePageAnswer {
        FilePageAnswer(text: text, offset: offset, nextOffset: offset + text.utf8.count, size: size, version: "v1", done: done)
    }

    @Test func eachPartGivesBackTheTextItWasReadAsAndLinesRunOnAcrossParts() {
        let first = "alpha\r\nbeta\n\n", second = "gamma\ndelta"
        let size = first.utf8.count + second.utf8.count
        var reading = LargeFileText()
        reading.take(page(first, at: 0, size: size))
        reading.take(page(second, at: first.utf8.count, size: size, done: true))
        #expect(reading.parts.map(\.text) == [first, second])
        #expect(reading.parts.map(\.firstLine) == [0, 3])
        #expect(reading.parts[1].offset == first.utf8.count && reading.parts[1].length == second.utf8.count)
        #expect(reading.lineCount == 5)
        #expect(reading.done && reading.percent == 100)
    }

    @Test func aPageThatDoesNotStartWhereTheLastEndedIsIgnored() {
        var reading = LargeFileText()
        reading.take(page("one\n", at: 0, size: 20))
        reading.take(page("late\n", at: 0, size: 20))
        #expect(reading.parts.count == 1)
        #expect(reading.percent == 20)
    }

    @Test func findCountsEveryMatchInAnyCaseWithItsLineAndColumn() {
        var reading = LargeFileText()
        reading.take(page("Event one\nnothing\n", at: 0, size: 100))
        reading.take(page("an event, another EVENT\n", at: 18, size: 100))
        #expect(reading.matches("event") == [.init(line: 0, column: 0), .init(line: 2, column: 3), .init(line: 2, column: 18)])
        #expect(reading.matches("").isEmpty)
        #expect(reading.matches("event", limit: 2).count == 2)
    }

    @Test func nextReadsOnBeforeWrappingAndPreviousWrapsToTheLast() {
        #expect(FindStep.next(from: nil, count: 3, done: false) == .show(0))
        #expect(FindStep.next(from: 1, count: 3, done: false) == .show(2))
        // At the last match read so far, more of the file may hold the next one.
        #expect(FindStep.next(from: 2, count: 3, done: false) == .readMore)
        #expect(FindStep.next(from: nil, count: 0, done: false) == .readMore)
        // Only once the whole file is read does Next go back to the first match.
        #expect(FindStep.next(from: 2, count: 3, done: true) == .show(0))
        #expect(FindStep.next(from: nil, count: 0, done: true) == FindStep.none)
        #expect(FindStep.previous(from: 0, count: 3) == .show(2))
        #expect(FindStep.previous(from: 2, count: 3) == .show(1))
        #expect(FindStep.previous(from: nil, count: 0) == FindStep.none)
    }
}
