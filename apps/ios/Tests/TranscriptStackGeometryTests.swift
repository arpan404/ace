import CoreGraphics
import Testing
@testable import Ace

@Suite struct TranscriptStackGeometryTests {
    /// Live end first: a tail, three rows, measured.
    private func measured(_ rows: [(String, CGFloat)]) -> TranscriptStackGeometry {
        var geometry = TranscriptStackGeometry()
        geometry.replace(rows.map(\.0))
        for (id, height) in rows { geometry.measure(id, height: height) }
        return geometry
    }

    @Test func anOlderPageJoiningAtTheFarEdgeLeavesTheReadersRowWhereItWas() {
        var geometry = measured([("tail", 1), ("c", 300), ("b", 500), ("a", 200)])
        let move = geometry.replace(["tail", "c", "b", "a", "z", "y", "x"], estimate: { _ in 900 }, keeping: "b")

        #expect(move == 0)
        #expect(geometry.top(of: "b") == 301)
        #expect(geometry.contentHeight == 1001 + 2700)
    }

    @Test func newerRowsTradedForASpacerOfTheirHeightLeaveTheReaderStill() {
        var geometry = measured([("tail", 1), ("d", 120), ("c", 180), ("b", 500), ("a", 200)])
        geometry.measure("after", height: 300)
        let move = geometry.replace(["tail", "after", "b", "a", "z"], keeping: "b")

        #expect(move == 0)
    }

    @Test func aRegroupedTurnBeforeTheReaderMovesTheOffsetByItsChangeSoTheReaderStaysOnScreen() {
        var geometry = measured([("tail", 1), ("c", 300), ("b", 500), ("a", 200)])
        geometry.measure("c+", height: 420)
        let move = geometry.replace(["tail", "c+", "b", "a"], keeping: "b")
        let offsetBefore: CGFloat = 250
        let onScreenBefore = 301 - offsetBefore
        let onScreenAfter = (geometry.top(of: "b") ?? 0) - (offsetBefore + move)

        #expect(move == 120)
        #expect(onScreenAfter == onScreenBefore)
    }

    @Test func aRowThatLeavesWithAPageComesBackAtItsMeasuredHeight() {
        var geometry = measured([("tail", 1), ("b", 640), ("a", 200)])
        geometry.replace(["tail", "a"])
        geometry.replace(["tail", "b", "a"], estimate: { _ in 80 })

        #expect(geometry.height(at: 1) == 640)
        #expect(geometry.top(of: "a") == 641)
    }

    @Test func anUnmeasuredRowStartsAtItsEstimateThenTheMeanOfMeasuredRows() {
        var geometry = measured([("b", 100), ("a", 300)])
        geometry.replace(["b", "a", "z", "y"], estimate: { $0 == "z" ? 50 : nil })

        #expect(geometry.height(at: 2) == 50)
        #expect(geometry.height(at: 3) == 200)
    }

    @Test func aMeasurementMovesOnlyTheRowsPastIt() {
        var geometry = measured([("tail", 1), ("c", 300), ("b", 500)])
        let change = geometry.measure("c", height: 340)

        #expect(change == 40)
        #expect(geometry.top(of: "c") == 1)
        #expect(geometry.top(of: "b") == 341)
        #expect(geometry.measure("c", height: 340) == nil)
    }

    @Test func aRowGrowingAboveTheViewportMovesTheOffsetAndOneOnScreenDoesNot() {
        #expect(TranscriptStackGeometry.offsetAdjustment(entryTop: 100, change: 40, viewportTop: 600) == 40)
        #expect(TranscriptStackGeometry.offsetAdjustment(entryTop: 600, change: 40, viewportTop: 600) == 0)
        #expect(TranscriptStackGeometry.offsetAdjustment(entryTop: 900, change: -40, viewportTop: 600) == 0)
    }

    @Test func theRowsOnScreenAreThoseMeetingTheViewport() {
        let geometry = measured([("tail", 1), ("c", 300), ("b", 500), ("a", 200)])

        #expect(geometry.indices(from: 250, to: 800) == 1..<3)
        #expect(geometry.firstIndex(reaching: 301) == 2)
        #expect(geometry.firstIndex(reaching: 2000) == nil)
    }
}
