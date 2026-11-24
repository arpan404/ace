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
        // The rows laid out before (1001) plus three joining at their estimate (3 x 900).
        let farEdge: CGFloat = 1001 + 2700
        #expect(geometry.contentHeight == farEdge)
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

    @Test func anOlderPageKeepsTheHeightsOfTheRowsItRetains() {
        // "c" sits between the live end and the reader and hasn't measured: it starts at the fallback.
        var geometry = TranscriptStackGeometry()
        geometry.replace(["tail", "c", "b"])
        geometry.measure("tail", height: 1)
        geometry.measure("b", height: 500)
        // A row elsewhere measures and moves the mean before the next page lands.
        geometry.measure("z", height: 900)
        let move = geometry.replace(["tail", "c", "b", "a"], estimate: { _ in 40 }, keeping: "b")

        #expect(move == 0)
        #expect(geometry.height(at: 1) == 120)
        #expect(geometry.top(of: "b") == 121)
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
        #expect(TranscriptStackGeometry.offsetAdjustment(entryTop: 100, change: 40, heldLine: 600) == 40)
        #expect(TranscriptStackGeometry.offsetAdjustment(entryTop: 600, change: 40, heldLine: 600) == 0)
        #expect(TranscriptStackGeometry.offsetAdjustment(entryTop: 900, change: -40, heldLine: 600) == 0)
    }

    @Test func aReaderAwayFromTheEndKeepsTheScreensTopStillAsARowOnScreenGrows() {
        // Viewport from 600 to 1400: held at its far edge, a row starting on screen moves the offset.
        #expect(TranscriptStackGeometry.offsetAdjustment(entryTop: 900, change: 40, heldLine: 1400) == 40)
        // A row past the screen's top grows where the reader isn't looking.
        #expect(TranscriptStackGeometry.offsetAdjustment(entryTop: 1500, change: 40, heldLine: 1400) == 0)
    }

    @Test func theRowsOnScreenAreThoseMeetingTheViewport() {
        let geometry = measured([("tail", 1), ("c", 300), ("b", 500), ("a", 200)])

        #expect(geometry.indices(from: 250, to: 800) == 1..<3)
        #expect(geometry.firstIndex(reaching: 301) == 2)
        #expect(geometry.firstIndex(reaching: 2000) == nil)
    }

    // A fling up the history: the tail, two loaded rows, then the far spacer standing for the
    // older rows not loaded yet (801 to 5801), and the end's blank edge.
    private func flingingThroughHistory() -> TranscriptStackGeometry {
        measured([("tail", 1), ("c", 300), ("b", 500), ("spacer.before", 5000), ("room.edge", 8)])
    }

    private let blanks: Set<String> = ["spacer.before", "room.edge"]

    private func anchor(_ geometry: TranscriptStackGeometry, from minY: CGFloat, to maxY: CGFloat,
                        keeping ids: [String], followsEnd: Bool = false) -> String? {
        geometry.readerAnchor(from: minY, to: maxY, keeping: Set(ids), followsEnd: followsEnd,
                              isRow: { $0.count == 1 }, isBlank: { blanks.contains($0) })
    }

    @Test func aPageLandingWhileTheReaderFlingsThroughTheFarSpacerLandsAtOnceAndMovesNothingOnScreen() {
        var geometry = flingingThroughHistory()
        // Three older rows join where the spacer began, and it shrinks by their height.
        let ids = ["tail", "c", "b", "z", "y", "x", "spacer.before", "room.edge"]
        let viewport: (CGFloat, CGFloat) = (2000, 2800)
        let held = anchor(geometry, from: viewport.0, to: viewport.1, keeping: ids)
        let move = geometry.replace(ids, declared: ["spacer.before": 2300, "room.edge": 8], estimate: { _ in 900 },
                                    keeping: held)

        // Only blank space was on screen: nothing to keep, so the page lands without an offset write.
        #expect(held == nil)
        #expect(move == 0)
        // The rows on screen come from the page where the spacer was.
        #expect(geometry.indices(from: viewport.0, to: viewport.1).map { geometry.ids[$0] } == ["y", "x"])
        #expect(geometry.contentHeight == 5809)
    }

    @Test func aPageLandingAsTheLoadedEdgeReachesTheScreenLeavesItsRowsWhereTheyWere() {
        var geometry = flingingThroughHistory()
        let ids = ["tail", "c", "b", "z", "spacer.before", "room.edge"]
        let held = anchor(geometry, from: 600, to: 1400, keeping: ids)
        let move = geometry.replace(ids, declared: ["spacer.before": 4400, "room.edge": 8], estimate: { _ in 600 },
                                    keeping: held)

        #expect(held == "b")
        #expect(move == 0)
        #expect(geometry.top(of: "b") == 301)
        // The spacer takes its new height in the same change: nothing remeasures on screen after.
        #expect(geometry.measure("spacer.before", height: 4400) == nil)
    }

    @Test func aReaderAwayFromTheEndIsAnchoredOnTheFirstRowOnScreenThenOnWhatIsDrawn() {
        let geometry = measured([("tail", 1), ("pending", 80), ("b", 500), ("spacer.before", 900)])

        #expect(anchor(geometry, from: 0, to: 700, keeping: geometry.ids) == "b")
        #expect(anchor(geometry, from: 0, to: 60, keeping: geometry.ids) == "tail")
        // Following the end, its first entry on screen holds, blank or not.
        #expect(anchor(geometry, from: 500, to: 1400, keeping: geometry.ids, followsEnd: true) == "b")
        #expect(anchor(geometry, from: 700, to: 1400, keeping: geometry.ids, followsEnd: true) == "spacer.before")
    }

    @Test func aSpacerResizedInPlaceKeepsTheReadersRowStill() {
        // A Dynamic Type change re-estimates the far spacer while the same entries stay laid out.
        var geometry = flingingThroughHistory()
        let held = anchor(geometry, from: 600, to: 1400, keeping: geometry.ids)
        let move = geometry.resize(declared: ["spacer.before": 6200, "room.edge": 8], keeping: held)

        #expect(move == 0)
        #expect(geometry.top(of: "b") == 301)
        #expect(geometry.contentHeight == 7009)
        // Heights already laid out change nothing.
        #expect(geometry.resize(declared: ["spacer.before": 6200, "room.edge": 8], keeping: held) == nil)
    }

    @Test func aRoomResizedInPlaceBeforeTheReaderMovesTheOffsetByItsChange() {
        var geometry = measured([("room.keyboard", 0), ("tail", 1), ("b", 500), ("a", 200)])
        let held = anchor(geometry, from: 300, to: 700, keeping: geometry.ids)
        let move = geometry.resize(declared: ["room.keyboard": 320], keeping: held)

        #expect(held == "b")
        #expect(move == 320)
    }
}
