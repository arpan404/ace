import Testing
@testable import Ace

@MainActor @Suite struct TranscriptFocusLandingTests {
    /// An 800-point screen under a 100-point header, over a 100-point composer.
    private let band = TranscriptFocusLanding.Band(top: 100, bottom: 700)
    private func aimed(_ item: String = "item.103") -> TranscriptFocusLanding {
        var landing = TranscriptFocusLanding()
        landing.jumped(to: item)
        return landing
    }

    @Test func aFocusedOpenWaitsForItsRowWhenTheOtherRowsLandFirst() {
        // The page's rows can settle before the reply naming the focus; the focus was already
        // known from the request, so the place stays held instead of adopting what is on top.
        var landing = aimed()
        #expect(landing.step(row: nil, frame: nil, band: band) == .wait)
        #expect(landing.holdsPlace)
    }

    @Test func aRowNotYetDrawnIsScrolledToAgainUntilItShows() {
        var landing = aimed()
        // Lazy rows below estimate: the first scroll lands short of the row.
        #expect(landing.step(row: "block:7", frame: nil, band: band) == .scroll(rowID: "block:7"))
        #expect(landing.step(row: "block:7", frame: .init(top: 2_400, bottom: 2_480), band: band) == .scroll(rowID: "block:7"))
        #expect(landing.step(row: "block:7", frame: .init(top: 690, bottom: 770), band: band) == .scroll(rowID: "block:7"))
        #expect(landing.holdsPlace)
        #expect(landing.step(row: "block:7", frame: .init(top: 360, bottom: 440), band: band) == .landed(rowID: "block:7"))
        #expect(!landing.holdsPlace)
        // Shown once: later layout is the ordinary held place's to keep.
        #expect(landing.step(row: "block:7", frame: .init(top: 2_400, bottom: 2_480), band: band) == .none)
    }

    @Test func aRowTallerThanTheScreenLandsWhenItsMiddleIsInView() {
        var landing = aimed()
        #expect(landing.step(row: "block:7", frame: .init(top: -500, bottom: 1_300), band: band) == .landed(rowID: "block:7"))
    }

    @Test func theReaderScrollingTakesThePlaceFromTheFocus() {
        var landing = aimed()
        _ = landing.step(row: "block:7", frame: nil, band: band)
        landing.readerTookOver()
        #expect(!landing.holdsPlace)
        #expect(landing.step(row: "block:7", frame: .init(top: 2_400, bottom: 2_480), band: band) == .none)
    }

    @Test func aRowThatNeverSettlesStopsBeingChasedAfterTheBudget() {
        var landing = aimed()
        for _ in 0..<TranscriptFocusLanding.maxScrolls {
            #expect(landing.step(row: "block:7", frame: .init(top: 2_400, bottom: 2_480), band: band) == .scroll(rowID: "block:7"))
        }
        #expect(landing.step(row: "block:7", frame: .init(top: 2_400, bottom: 2_480), band: band) == .none)
        #expect(!landing.holdsPlace)
    }

    @Test func aNewFocusStartsAFreshBudget() {
        var landing = aimed()
        for _ in 0..<TranscriptFocusLanding.maxScrolls { _ = landing.step(row: "block:7", frame: nil, band: band) }
        landing.jumped(to: "item.20")
        #expect(landing.step(row: "block:2", frame: nil, band: band) == .scroll(rowID: "block:2"))
    }

    @Test func theReaderScrollingBeforeATurnsReplyKeepsTheirPlace() {
        var landing = TranscriptFocusLanding()
        landing.jumped(to: nil)
        landing.readerTookOver()
        landing.replied(focus: "item.40")
        #expect(!landing.holdsPlace)
    }
}
