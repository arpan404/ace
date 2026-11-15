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
}
