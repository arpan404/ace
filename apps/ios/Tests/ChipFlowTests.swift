import CoreGraphics
import Testing
@testable import Ace

@Suite struct ChipFlowTests {
    private func sizes(_ widths: [CGFloat], height: CGFloat = 20) -> [CGSize] { widths.map { CGSize(width: $0, height: height) } }

    @Test func chipsWrapOntoANewRowWhenTheNextWouldOverrun() {
        let rows = ChipFlow.rows(sizes([40, 50, 30, 60]), width: 130, spacing: 4)
        #expect(rows.map(\.indexes) == [[0, 1, 2], [3]])
        #expect(rows[0].width == 128)
    }
    @Test func aChipWiderThanTheRowTakesARowOfItsOwnAtTheRowsWidth() {
        let rows = ChipFlow.rows(sizes([30, 500, 30]), width: 100, spacing: 4)
        #expect(rows.map(\.indexes) == [[0], [1], [2]])
        #expect(rows[1].width == 100)
    }
    @Test func aRowIsAsTallAsItsTallestChip() {
        let rows = ChipFlow.rows([CGSize(width: 10, height: 20), CGSize(width: 10, height: 32)], width: 100, spacing: 4)
        #expect(rows.count == 1)
        #expect(rows[0].height == 32)
    }
    @Test func noChipsMakeNoRows() {
        #expect(ChipFlow.rows([], width: 100, spacing: 4).isEmpty)
    }
    /// SwiftUI places a flow at the width it said it needed, rounded to the screen's pixels. If
    /// packing again at that width wrapped a chip, the flow would grow a row, be laid out again at
    /// the wider width, and swap between the two for good: the stall after opening a long
    /// finished thread (#2051), 7,000 chip measurements a second with nothing else changing.
    @Test func rowsPackedAgainAtTheWidthTheyCameOutAtAreTheSameRows() {
        let cases: [([CGFloat], CGFloat)] = [
            ([100.4, 99.9, 60], 210), ([33.7, 41.2, 58.9, 12.4, 77.1], 160), ([120.25, 80.6], 362),
            ([62.35, 62.35, 62.35, 62.35, 62.35], 300), ([10.1], 50),
        ]
        for (widths, width) in cases {
            let rows = ChipFlow.rows(sizes(widths), width: width, spacing: 4)
            let used = rows.map(\.width).max() ?? 0
            for scale in [2.0, 3.0] as [CGFloat] {
                let placed = (used * scale).rounded(.down) / scale
                #expect(ChipFlow.rows(sizes(widths), width: placed, spacing: 4) == rows, "\(widths) at \(placed)")
            }
        }
    }
    @Test func askingForRowsAtOtherWidthsNeverMeasuresTheChipsAgain() {
        var cache = ChipFlow.Cache()
        var measured = 0
        let measure = { () -> [CGSize] in measured += 1; return [CGSize(width: 100.4, height: 20), CGSize(width: 99.9, height: 20)] }
        let wide = cache.rows(width: 362, spacing: 4, measure: measure)
        let placed = cache.rows(width: 204.3, spacing: 4, measure: measure)
        let ideal = cache.rows(width: .infinity, spacing: 4, measure: measure)
        let narrow = cache.rows(width: 150, spacing: 4, measure: measure)
        #expect(measured == 1)
        #expect(wide.map(\.indexes) == [[0, 1]])
        #expect(placed == wide)
        #expect(ideal == wide)
        #expect(narrow.map(\.indexes) == [[0], [1]])
    }
}
