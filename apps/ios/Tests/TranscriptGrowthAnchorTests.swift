import Testing
@testable import Ace

/// Which edge holds still as the transcript's lazy rows correct their heights: the bottom while a
/// thread opens at its end and while an older page lands, the top once the reader moves.
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

    @Test func anOlderPageHoldsTheBottomFromItsRequestUntilItSettles() {
        var anchor = TranscriptGrowthAnchor()
        anchor.olderRequested()
        #expect(anchor.keepsEnd)
        anchor.olderSettled()
        #expect(!anchor.keepsEnd)
    }

    @Test func theReaderMovingDuringAnOlderPageStopsHoldingTheBottom() {
        var anchor = TranscriptGrowthAnchor()
        anchor.olderRequested()
        anchor.readerMoved()
        #expect(!anchor.keepsEnd)
    }

    @Test func anOlderPageSettlingLeavesAnOpeningsHoldInPlace() {
        var anchor = TranscriptGrowthAnchor()
        anchor.opened(atEnd: true)
        anchor.olderRequested()
        anchor.olderSettled()
        #expect(anchor.keepsEnd, "the thread still sits at the end it opened on")
    }
}
