import Testing
@testable import Ace

/// Which edge holds still as the transcript's lazy rows correct their heights: the bottom while a
/// thread opens at its end, the top once the reader moves.
@Suite struct TranscriptGrowthAnchorTests {
    @Test func aThreadOpeningAtItsEndHoldsTheBottomUntilTheReaderMovesIt() {
        var anchor = TranscriptGrowthAnchor()
        #expect(!anchor.keepsEnd, "nothing is held before the rows lay out")
        anchor.opened(atEnd: true)
        #expect(anchor.keepsEnd)
        anchor.readerMoved()
        #expect(!anchor.keepsEnd)
    }

    @Test func aThreadReopeningAwayFromItsEndHoldsItsTop() {
        var anchor = TranscriptGrowthAnchor()
        anchor.opened(atEnd: false)
        #expect(!anchor.keepsEnd)
    }

    @Test func leavingTheEndWithoutTheReadersHandStopsHoldingTheBottom() {
        var anchor = TranscriptGrowthAnchor()
        anchor.opened(atEnd: true)
        anchor.leftEnd()
        #expect(!anchor.keepsEnd)
    }
}
