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

    @Test func anOpeningThatHasSettledHoldsItsTopAgain() {
        var anchor = TranscriptGrowthAnchor()
        anchor.opened(atEnd: true)
        anchor.openSettled()
        #expect(!anchor.keepsEnd, "new rows and a later drag behave as they did before the open")
    }

    @Test func freshRowsLandingUnderAReaderAtTheEndKeepTheBottomStill() {
        // Kept rows (or the opening's tail) were shown and settled; the whole window then lands.
        var anchor = TranscriptGrowthAnchor()
        anchor.opened(atEnd: true)
        anchor.openSettled()
        #expect(anchor.windowGrowing(following: true) == .end)
        #expect(anchor.keepsEnd, "rows joining above leave the newest message where it is")
        anchor.openSettled()
        #expect(!anchor.keepsEnd)
    }

    @Test func freshRowsLandingUnderAReaderInHistoryKeepTheirRowOnTop() {
        var anchor = TranscriptGrowthAnchor()
        #expect(anchor.windowGrowing(following: false) == .topRow)
        #expect(!anchor.keepsEnd, "the reader's row is held instead (an older page's hold)")
    }

    @Test func aWindowHoldEndedByAnyScrollStopsHoldingTheBottom() {
        // A programmatic scroll can end the hold before it settles: the bottom is let go all the
        // same, so a later row resize doesn't pin it.
        var anchor = TranscriptGrowthAnchor()
        _ = anchor.windowGrowing(following: true)
        anchor.windowHoldEnded()
        #expect(!anchor.keepsEnd)
    }

    @Test func endingAnOlderPagesHoldLeavesTheOpeningsBottomHold() {
        var anchor = TranscriptGrowthAnchor()
        anchor.opened(atEnd: true)
        anchor.windowHoldEnded()
        #expect(anchor.keepsEnd, "only a hold the window started is let go")
    }
}
