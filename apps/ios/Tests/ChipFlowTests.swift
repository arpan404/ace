import CoreGraphics
import Testing
@testable import Ace

@Suite struct ChipFlowTests {
    private func sizes(_ widths: [CGFloat], height: CGFloat = 20) -> [CGSize] { widths.map { CGSize(width: $0, height: height) } }

    @Test func chipsWrapOntoANewRowWhenTheNextWouldOverrun() {
        let rows = ChipFlow.rows(sizes([40, 50, 30, 60]), capacity: 130, spacing: 4)
        #expect(rows.map(\.indexes) == [[0, 1, 2], [3]])
        #expect(rows[0].width == 128)
    }
    @Test func aChipWiderThanTheRowTakesARowOfItsOwnAtTheRowsWidth() {
        let rows = ChipFlow.rows(sizes([30, 500, 30]), capacity: 100, spacing: 4)
        #expect(rows.map(\.indexes) == [[0], [1], [2]])
        #expect(rows[1].width == 100)
    }
    @Test func aRowIsAsTallAsItsTallestChip() {
        let rows = ChipFlow.rows([CGSize(width: 10, height: 20), CGSize(width: 10, height: 32)], capacity: 100, spacing: 4)
        #expect(rows.count == 1)
        #expect(rows[0].height == 32)
    }
    @Test func noChipsMakeNoRows() {
        #expect(ChipFlow.rows([], capacity: 100, spacing: 4).isEmpty)
    }
    /// SwiftUI places a flow at the width it reported, on the screen's pixels. If packing at the
    /// placed width wrapped a chip, the flow would be taller than it said and lay out again at
    /// the wider width (#2051). `fit` is what `sizeThatFits` returns, its `min` included.
    private func placedAgain(_ widths: [CGFloat], proposal: CGFloat, scale: CGFloat) {
        let fit = ChipFlow.fit(sizes(widths), proposal: proposal, spacing: 4, scale: scale)
        for placed in [(fit.size.width * scale).rounded(.down) / scale, (fit.size.width * scale).rounded() / scale] {
            let again = ChipFlow.rows(sizes(widths), capacity: ChipFlow.capacity(placed, scale: scale), spacing: 4)
            #expect(again == fit.rows, "\(widths) proposed \(proposal) at \(scale)x, placed at \(placed)")
            #expect(ChipFlow.size(of: again, spacing: 4, scale: scale).height == fit.size.height)
        }
    }
    @Test func twoChipsThatFitOnlyBeforeRoundingStayOnOneRowWherePlaced() {
        // 100.2 + 4 + 96.4 = 200.6 against a proposal of 200.2: whatever the scale, the rows the
        // flow reports are the rows it lays out where SwiftUI puts it.
        for scale in [1.0, 2.0, 3.0] as [CGFloat] { placedAgain([100.2, 96.4], proposal: 200.2, scale: scale) }
    }
    @Test func rowsPackedAgainWhereTheFlowIsPlacedAreTheSameRows() {
        let cases: [([CGFloat], CGFloat)] = [
            ([100.4, 99.9, 60], 210), ([33.7, 41.2, 58.9, 12.4, 77.1], 160), ([120.25, 80.6], 362),
            ([62.35, 62.35, 62.35, 62.35, 62.35], 300), ([10.1], 50), ([100.2, 96.4], 200.2), ([200.5], 200.2),
        ]
        for (widths, proposal) in cases {
            for scale in [2.0, 3.0] as [CGFloat] { placedAgain(widths, proposal: proposal, scale: scale) }
        }
    }
    @Test func theReportedWidthNeverPassesTheProposal() {
        for scale in [2.0, 3.0] as [CGFloat] {
            let fit = ChipFlow.fit(sizes([100.2, 96.4, 500]), proposal: 200.2, spacing: 4, scale: scale)
            #expect(fit.size.width <= 200.2)
        }
    }
    @Test func askingForRowsAtOtherWidthsNeverMeasuresTheChipsAgain() {
        var cache = ChipFlow.Cache()
        var measured = 0
        let measure = { () -> [CGSize] in measured += 1; return [CGSize(width: 100.4, height: 20), CGSize(width: 99.9, height: 20)] }
        let wide = cache.rows(capacity: 362, spacing: 4, measure: measure)
        let placed = cache.rows(capacity: 204.33, spacing: 4, measure: measure)
        let ideal = cache.rows(capacity: .infinity, spacing: 4, measure: measure)
        let narrow = cache.rows(capacity: 150, spacing: 4, measure: measure)
        #expect(measured == 1)
        #expect(wide.map(\.indexes) == [[0, 1]])
        #expect(placed == wide)
        #expect(ideal == wide)
        #expect(narrow.map(\.indexes) == [[0], [1]])
    }
}
