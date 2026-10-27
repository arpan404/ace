import Testing
@testable import Ace

/// A check's log on the phone: a running log keeps growing, a new run starts over, and a slow
/// answer never overwrites a newer one.
@Suite struct ForgeLogPagingTests {
    private func lines(_ range: Range<Int>) -> [String] { range.map { "line \($0)" } }

    @Test func aRunningLogReadsItsTailAgainAndShowsTheLinesWrittenSince() {
        var log = ForgeLogPaging(identity: "local=run-1")
        let first = log.near(0)
        #expect(first.count == 1)
        log.accept(first[0], lines: lines(0..<3), total: 3)
        #expect(log.lines == 3 && log.line(2) == "line 2")
        // The page was read once; only the tail read asks for it again.
        #expect(log.near(0).isEmpty)
        let tail = log.tail()
        #expect(tail.map(\.page) == [0, 1])
        log.accept(tail[0], lines: lines(0..<5), total: 5)
        #expect(log.lines == 5 && log.line(4) == "line 4")
    }

    @Test func anAnswerForAnOlderReadOfThePageIsDropped() {
        var log = ForgeLogPaging(identity: "local=run-1")
        let early = log.near(0)[0]
        log.accept(early, lines: lines(0..<2), total: 2)
        let slow = log.tail()[0]
        log.failed(slow)
        let fresh = log.tail()[0]
        let taken1 = log.accept(fresh, lines: lines(0..<4), total: 4)
        #expect(taken1)
        // The failed read's late answer, and a repeat of the first, change nothing.
        let taken2 = log.accept(slow, lines: lines(0..<1), total: 1)
        #expect(!taken2)
        let taken3 = log.accept(early, lines: lines(0..<1), total: 1)
        #expect(!taken3)
        #expect(log.lines == 4 && log.line(3) == "line 3")
    }

    @Test func anotherLogStartsOverAndAnswersForTheOldOneAreDropped() {
        var log = ForgeLogPaging(identity: "local=run-1")
        let old = log.near(0)[0]
        log.show("local=run-2", total: nil)
        let taken4 = log.accept(old, lines: lines(0..<9), total: 9)
        #expect(!taken4)
        #expect(log.count == nil && log.line(0) == nil)
        let fresh = log.near(0)[0]
        let taken5 = log.accept(fresh, lines: lines(0..<2), total: 2)
        #expect(taken5)
        #expect(log.line(1) == "line 1")
    }

    @Test func theSameLogKeepsItsPagesAndTakesALargerTotalFromItsPage() {
        var log = ForgeLogPaging(identity: "check=7", total: 300)
        let first = log.near(0)[0]
        log.accept(first, lines: lines(0..<200), total: 300)
        log.show("check=7", total: 450)
        #expect(log.lines == 450 && log.line(10) == "line 10")
    }
}
