import CoreGraphics
import Testing
@testable import Ace

@Suite struct TranscriptScrollAxisTests {
    @Test func anOlderAppendExtendsTheFarEdgeAtTheSameNativeOffset() {
        let nativeOffset: CGFloat = 1880
        let old = TranscriptScrollAxis.distances(offset: nativeOffset, content: 3000, viewport: 800, startInset: 20)
        let page = TranscriptScrollAxis.distances(offset: nativeOffset, content: 4200, viewport: 800, startInset: 20)

        #expect(page.live == old.live)
        #expect(page.older - old.older == 1200)
    }

    @Test func anOlderRowMovesDownScreenAsTheNativeOffsetAdvancesTowardHistory() {
        let row = TranscriptScrollAxis.row(CGRect(x: 12, y: 520, width: 340, height: 120))
        let first = row.minY + TranscriptScrollAxis.origin(offset: 20, viewport: 800)
        let later = row.minY + TranscriptScrollAxis.origin(offset: 120, viewport: 800)

        #expect(first == 180)
        #expect(later == 280)
    }

    @Test func theOlderRowSitsAboveItsNewerNeighbourInChronologicalCoordinates() {
        let newer = TranscriptScrollAxis.row(CGRect(x: 12, y: 400, width: 340, height: 85))
        let older = TranscriptScrollAxis.row(CGRect(x: 12, y: 485, width: 340, height: 170))

        #expect(older.maxY == newer.minY)
        #expect(older.height == 170)
        #expect(older.minX == 12)
    }
}
