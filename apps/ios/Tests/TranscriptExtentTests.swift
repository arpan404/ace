import Foundation
import Testing
@testable import Ace

@MainActor @Suite struct TranscriptExtentTests {
    @Test func pagingUsesTheResidentEdgesAndFillsNewerRetainedSpaceAfterAFling() {
        let extent = TranscriptExtent()
        extent.update(["a", "b"], movement: .replace)
        extent.measure("a", height: 1000)
        extent.measure("b", height: 1000)
        extent.update(["c", "d"], movement: .newer)
        #expect(extent.edge(top: 100, bottom: 1000, viewport: 100, minimumAhead: 44, direction: -1) == .older)
        #expect(!extent.needsNewerContent(bottom: 1000))
        extent.update(["a", "b"], movement: .older)
        #expect(extent.edge(top: 1000, bottom: 100, viewport: 100, minimumAhead: 44, direction: 1) == .newer)
        #expect(extent.needsNewerContent(bottom: 100))
    }

    @Test func anUpwardFlingPrefetchesWithTwoScreensOfLoadedHistoryLeft() {
        let extent = TranscriptExtent()
        extent.update(["a"], movement: .replace)
        extent.measure("a", height: 1_000)
        extent.update(["b"], movement: .newer)

        #expect(extent.edge(top: 1_600, bottom: 4_000, viewport: 800, minimumAhead: 44, direction: -1) == .older)
        #expect(extent.edge(top: 2_400, bottom: 4_000, viewport: 800, minimumAhead: 44, direction: -1) == nil)
        #expect(extent.edge(top: 1_600, bottom: 1_600, viewport: 800, minimumAhead: 44, direction: 1) == nil)
        #expect(extent.edge(top: 1_600, bottom: 4_000, viewport: 800, minimumAhead: 44, direction: 0) == nil)
    }

    @Test func evictedOlderHistoryDoesNotAskForAnOlderPageWhileReadingNewer() {
        let extent = TranscriptExtent()
        extent.update(["a"], movement: .replace)
        extent.measure("a", height: 1_000)
        extent.update(["b"], movement: .newer)
        #expect(extent.edge(top: 400, bottom: 4_000, viewport: 800, minimumAhead: 44, direction: 1) == nil)
        #expect(extent.edge(top: 400, bottom: 4_000, viewport: 800, minimumAhead: 44, direction: 0) == nil)
    }

    @Test func aFastFlingAsksForTheOlderPageAsSoonAsItsTravelWouldReachTheLoadedEdge() {
        let extent = TranscriptExtent()
        extent.update(["a"], movement: .replace)
        extent.measure("a", height: 1_000)
        extent.update(["b"], movement: .newer)
        // The loaded edge is 4,000 pt (five screens) above the screen's top.
        let fast = TranscriptFlingReach(offset: 0, velocity: 8_000).remaining(at: 0)
        let slow = TranscriptFlingReach(offset: 0, velocity: 500).remaining(at: 0)

        #expect(fast > 3_900 && fast < 4_100)
        #expect(extent.edge(top: 4_000, bottom: 4_000, viewport: 800, minimumAhead: 44, direction: -1,
                            flingReach: fast) == .older)
        #expect(extent.edge(top: 4_000, bottom: 4_000, viewport: 800, minimumAhead: 44, direction: -1,
                            flingReach: slow) == nil)
        #expect(extent.edge(top: 4_000, bottom: 4_000, viewport: 800, minimumAhead: 44, direction: -1) == nil)
    }

    @Test func aFlingLooksAheadOnlyAsFarAsItStillCarries() {
        let fling = TranscriptFlingReach(offset: 1_000, velocity: 8_000)
        let stop = fling.stop

        // Most of the travel spent: only what's left counts.
        #expect(fling.remaining(at: stop - 300) == 300)
        #expect(fling.remaining(at: stop) == 0)
        // Past its stop (a page moved the content under it), nothing is left.
        #expect(fling.remaining(at: stop + 50) == 0)
        // A fling toward the live end carries the other way.
        let down = TranscriptFlingReach(offset: 5_000, velocity: -2_000)
        #expect(down.stop < 5_000)
        #expect(down.remaining(at: 5_000) == 5_000 - down.stop)
    }

    @Test func pagingOlderKeepsTheHeightOfNewerRowsOutsideTheResidentWindow() {
        let extent = TranscriptExtent()
        extent.update(["b", "c", "d"], movement: .replace)
        extent.measure("b", height: 100)
        extent.measure("c", height: 200)
        extent.measure("d", height: 300)
        extent.update(["a", "b", "c"], movement: .older)
        #expect(extent.before == 0)
        #expect(extent.after == 300)
        extent.update(["b", "c", "d"], movement: .newer)
        #expect(extent.after == 0)
        // The newly discovered older row keeps its estimated space until measured.
        #expect(extent.before > 0)
    }

    @Test func movingBackAndForthPreservesTheTotalExtentOfMeasuredHistory() {
        let extent = TranscriptExtent()
        extent.update(["a", "b", "c"], movement: .replace)
        for id in ["a", "b", "c"] { extent.measure(id, height: 100) }
        extent.update(["b", "c", "d"], movement: .newer)
        extent.measure("d", height: 150)
        #expect(extent.before + 350 + extent.after == 450)
        extent.update(["a", "b", "c"], movement: .older)
        #expect(extent.before + 300 + extent.after == 450)
        extent.update(["b", "c", "d"], movement: .newer)
        #expect(extent.before + 350 + extent.after == 450)
    }

    @Test func regroupingWithinTheResidentWindowDoesNotLeaveGhostSpace() {
        let extent = TranscriptExtent()
        extent.update(["a", "work", "b"], movement: .replace)
        extent.measure("work", height: 500)
        extent.update(["a", "b"], movement: .newer)
        #expect(extent.before == 0)
        #expect(extent.after == 0)
    }

    @Test func aCompletePageTurnoverRetainsSpaceAndANewJumpResetsIt() {
        let extent = TranscriptExtent()
        extent.update(["c", "d"], movement: .replace)
        extent.measure("c", height: 100)
        extent.measure("d", height: 200)
        extent.update(["a", "b"], movement: .older)
        #expect(extent.after == 300)
        extent.update(["x", "y"], movement: .replace)
        #expect(extent.before == 0)
        #expect(extent.after == 0)
    }
}
