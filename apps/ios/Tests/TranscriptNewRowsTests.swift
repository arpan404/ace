import Testing
@testable import Ace

/// The count on Scroll to end: rows that landed while the reader was away from the live end.
@Suite struct TranscriptNewRowsTests {
    private func reading(from order: [String]) -> TranscriptNewRows {
        var rows = TranscriptNewRows()
        rows.update(order: order, atEnd: true)
        return rows
    }

    @Test func countGrowsWhenANewRowLandsWhileScrolledUp() {
        var rows = reading(from: ["a", "b"])
        rows.update(order: ["a", "b"], atEnd: false)
        #expect(rows.count == 0)
        rows.update(order: ["a", "b", "c"], atEnd: false)
        #expect(rows.count == 1)
        rows.update(order: ["a", "b", "c", "d", "e"], atEnd: false)
        #expect(rows.count == 3)
        #expect(rows.badge == "3")
    }

    @Test func aStreamingUpdateToAnExistingRowDoesNotCount() {
        var rows = reading(from: ["a", "b"])
        // A streaming reply changes its row's content, never the order.
        for _ in 0..<20 { rows.update(order: ["a", "b"], atEnd: false) }
        #expect(rows.count == 0)
        #expect(rows.badge == nil)
    }

    @Test func reachingTheEndClearsIt() {
        var rows = reading(from: ["a"])
        rows.update(order: ["a", "b", "c"], atEnd: false)
        #expect(rows.count == 2)
        rows.reachedEnd(order: ["a", "b", "c"])
        #expect(rows.count == 0)
        // Only rows after the ones seen at the end count next time.
        rows.update(order: ["a", "b", "c", "d"], atEnd: false)
        #expect(rows.count == 1)
    }

    @Test func rowsArrivingAtTheEndAreSeen() {
        var rows = reading(from: ["a"])
        rows.update(order: ["a", "b"], atEnd: true)
        rows.update(order: ["a", "b", "c"], atEnd: false)
        #expect(rows.count == 1)
    }

    @Test func olderRowsPagingInDoNotCount() {
        var rows = reading(from: ["c", "d"])
        rows.update(order: ["a", "b", "c", "d"], atEnd: false)
        #expect(rows.count == 0)
    }

    @Test func countsKeepWhenTheSeenRowLeavesTheWindow() {
        var rows = reading(from: ["a", "b"])
        rows.update(order: ["a", "b", "c"], atEnd: false)
        rows.update(order: ["a", "c"], atEnd: false)
        #expect(rows.count == 1)
        rows.update(order: ["a", "c", "d"], atEnd: false)
        #expect(rows.count == 2)
    }

    @Test func theBadgeCapsAtNinetyNinePlus() {
        var rows = reading(from: ["0"])
        rows.update(order: (0...150).map(String.init), atEnd: false)
        #expect(rows.count == 150)
        #expect(rows.badge == "99+")
    }
}
