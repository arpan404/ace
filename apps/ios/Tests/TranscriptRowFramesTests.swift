import CoreGraphics
import Testing
@testable import Ace

/// Rows are kept where they sit in the transcript's content; a scroll moves only the content's
/// origin. Positions on screen come from the two together, when asked for (#2051).
@Suite struct TranscriptRowFramesTests {
    /// Three 100-point rows stacked from the top of the content.
    private func stacked() -> TranscriptRowFrames {
        var rows = TranscriptRowFrames()
        for (index, id) in ["a", "b", "c"].enumerated() {
            _ = rows.record(id, frame: CGRect(x: 0, y: CGFloat(index) * 100, width: 320, height: 100))
        }
        return rows
    }

    @Test func theTopRowFollowsAScrollWithNoRowMeasuredAgain() {
        var rows = stacked()
        #expect(rows.topRow(of: ["a", "b", "c"], inset: 0) == "a")
        // The reader scrolled 150 points down: only the origin moves.
        let moved = rows.scrolled(origin: -150)
        #expect(moved)
        #expect(rows.topRow(of: ["a", "b", "c"], inset: 0) == "b")
        #expect(rows.top("b", inset: 0) == -50)
        #expect(rows.frame("c") == CGRect(x: 0, y: 50, width: 320, height: 100))
    }

    @Test func aRowSeenAgainAtTheSamePlaceInTheContentIsUnchangedWhateverTheScroll() {
        var rows = stacked()
        _ = rows.scrolled(origin: -420)
        let change = rows.record("b", frame: CGRect(x: 0, y: 100, width: 320, height: 100))
        #expect(change == .unchanged)
        let movedAgain = rows.scrolled(origin: -420)
        #expect(!movedAgain)
    }

    @Test func aRowThatGrowsIsResizedAndTheRowsBelowItOnlyMove() {
        var rows = stacked()
        let grown = rows.record("a", frame: CGRect(x: 0, y: 0, width: 320, height: 160))
        let below = rows.record("b", frame: CGRect(x: 0, y: 160, width: 320, height: 100))
        #expect(grown == .resized)
        #expect(below == .moved)
        #expect(rows.top("b", inset: 0) == 160)
    }

    @Test func aRowComingOnScreenAppears() {
        var rows = stacked()
        rows.forget("c")
        #expect(rows.frame("c") == nil)
        let back = rows.record("c", frame: CGRect(x: 0, y: 200, width: 320, height: 100))
        #expect(back == .appeared)
    }

    @Test func topsAreMeasuredBelowTheHeaderInset() {
        var rows = stacked()
        _ = rows.scrolled(origin: 60)
        // Row a starts at 60 in the viewport, which is where a 60-point header ends.
        #expect(rows.top("a", inset: 60) == 0)
        // Hidden under a header that ends at 170, a no longer counts as the top row.
        #expect(rows.topRow(of: ["a", "b", "c"], inset: 170) == "b")
    }

    @Test func theTopRowIsOnlyOneOfTheRowsShown() {
        let rows = stacked()
        #expect(rows.topRow(of: ["b", "c"], inset: 0) == "b")
        #expect(rows.topRow(of: [], inset: 0) == nil)
    }

    @Test func driftInsideThePlacementToleranceNeedsNoCorrection() {
        #expect(TranscriptRowPlacement.drift(top: 41.5, target: 40) == nil)
        #expect(TranscriptRowPlacement.drift(top: 43, target: 40) == 3)
        #expect(TranscriptRowPlacement.drift(top: 30, target: 40) == -10)
        #expect(TranscriptRowPlacement.settled(top: 38.5, target: 40))
        #expect(!TranscriptRowPlacement.settled(top: 37, target: 40))
    }
}
