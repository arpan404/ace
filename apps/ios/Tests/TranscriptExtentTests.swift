import Foundation
import Testing
@testable import Ace

@MainActor @Suite struct TranscriptExtentTests {
    @Test func pagingUsesTheResidentEdgeAndFillsRetainedSpaceAfterAFling() {
        let extent = TranscriptExtent()
        extent.update(["a", "b"], movement: .replace)
        extent.measure("a", height: 1000)
        extent.measure("b", height: 1000)
        extent.update(["c", "d"], movement: .newer)
        #expect(extent.edge(top: 2100, bottom: 1000, ahead: 200, direction: -1) == .older)
        #expect(extent.needsContent(top: 1900, bottom: 1000))
        extent.update(["a", "b"], movement: .older)
        #expect(extent.edge(top: 1000, bottom: 100, ahead: 200, direction: 1) == .newer)
        #expect(extent.needsContent(top: 1000, bottom: 100))
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
