import Testing
@testable import Ace

@MainActor @Suite struct TranscriptFocusLandingTests {
    /// An 800-point feed under a 100-point header and over a 50-point home indicator, with a
    /// 100-point composer floating over its bottom edge: the reader sees 100 to 650.
    private let screen = TranscriptFocusLanding.Geometry(viewport: 800, topInset: 100, bottomInset: 50, covered: 100)
    /// The same feed with a 300-point keyboard up as well: the reader sees 100 to 350.
    private let keyboard = TranscriptFocusLanding.Geometry(viewport: 800, topInset: 100, bottomInset: 50, covered: 400)
    private let start = 1_000_000.0
    private func aimed(_ item: String = "item.103") -> TranscriptFocusLanding {
        var landing = TranscriptFocusLanding()
        landing.jumped(to: item, now: start)
        return landing
    }
    private func row(_ top: Double, _ bottom: Double) -> TranscriptFocusLanding.Span { .init(top: top, bottom: bottom) }

    @Test func aFocusedOpenWaitsForItsRowWhenTheOtherRowsLandFirst() {
        // The page's rows can settle before the reply naming the focus; the focus was already
        // known from the request, so the place stays held instead of adopting what is on top.
        var landing = aimed()
        #expect(landing.step(row: nil, frame: nil, in: screen, now: start + 10) == .wait)
        #expect(landing.holdsPlace)
    }

    @Test func aRowNotYetDrawnIsScrolledToAgainUntilItShows() {
        var landing = aimed()
        // Not drawn yet: its height is unknown, so it is centred and placed once it measures.
        #expect(landing.step(row: "block:7", frame: nil, in: screen, now: start) == .scroll(rowID: "block:7", anchor: nil))
        // Lazy rows above it drew taller than estimated: the scroll landed short.
        guard case .scroll("block:7", .some) = landing.step(row: "block:7", frame: row(2_400, 2_480), in: screen, now: start) else {
            Issue.record("a row drawn off screen is placed again"); return
        }
        #expect(landing.holdsPlace)
        #expect(landing.step(row: "block:7", frame: row(335, 415), in: screen, now: start) == .landed(rowID: "block:7"))
        #expect(!landing.holdsPlace)
        // Shown once: later layout is the ordinary held place's to keep.
        #expect(landing.step(row: "block:7", frame: row(2_400, 2_480), in: screen, now: start) == .none)
    }

    @Test func theRowIsPlacedInTheMiddleOfWhatTheReaderSeesNotOfTheWholeFeed() {
        // With the keyboard up the reader sees 100 to 350, so a row centred in the whole feed
        // (360 to 440) is hidden, and a scroll to the feed's centre would only put it back there.
        var landing = aimed()
        guard case .scroll(_, .some(let anchor)) = landing.step(row: "block:7", frame: row(360, 440), in: keyboard, now: start) else {
            Issue.record("a measured row is placed by a computed anchor"); return
        }
        // Where that anchor puts the row: the same fraction of the row and of the scrolled
        // space (the feed inside its insets) line up.
        let space = 800.0 - 100 - 50
        let top = 100 + anchor * (space - 80)
        #expect(abs((top + 40) - 225) < 1, "the row's middle sits at the middle of 100 to 350")
        #expect(landing.step(row: "block:7", frame: row(top, top + 80), in: keyboard, now: start) == .landed(rowID: "block:7"))
    }

    @Test func aRowTallerThanTheScreenLandsWhenItsMiddleIsInView() {
        var landing = aimed()
        #expect(landing.step(row: "block:7", frame: row(-500, 1_250), in: screen, now: start) == .landed(rowID: "block:7"))
    }

    @Test func theReaderScrollingTakesThePlaceFromTheFocus() {
        var landing = aimed()
        _ = landing.step(row: "block:7", frame: nil, in: screen, now: start)
        landing.readerTookOver()
        #expect(!landing.holdsPlace)
        #expect(landing.step(row: "block:7", frame: row(2_400, 2_480), in: screen, now: start) == .none)
    }

    @Test func theReaderTakingOverBeforeTheReplyKeepsTheirPlaceWhenItArrives() {
        // A turn key, Scroll to end, or VoiceOver scrolling while the jump is still in flight.
        var landing = aimed()
        landing.readerTookOver()
        landing.replied(focus: "item.103", now: start + 500)
        #expect(!landing.holdsPlace)
        #expect(landing.step(row: "block:7", frame: nil, in: screen, now: start + 600) == .none)
    }

    @Test func aRowThatNeverSettlesStopsBeingChasedAfterTheBudget() {
        var landing = aimed()
        for _ in 0..<TranscriptFocusLanding.maxScrolls {
            #expect(landing.step(row: "block:7", frame: nil, in: screen, now: start) == .scroll(rowID: "block:7", anchor: nil))
        }
        #expect(landing.step(row: "block:7", frame: nil, in: screen, now: start) == .none)
        #expect(!landing.holdsPlace)
    }

    @Test func aRowThatNeverLandsLetsThePlaceGoAtTheDeadline() {
        // The reply named the focus, but its row never arrives and nothing else lays out: only
        // the shell's tick at the deadline is left to end it.
        var landing = aimed()
        landing.replied(focus: "item.103", now: start + 2_000)
        #expect(landing.step(row: nil, frame: nil, in: screen, now: start + 2_100) == .wait)
        let deadline = landing.deadline
        #expect(deadline == start + 2_000 + TranscriptFocusLanding.landLimit)
        landing.expire(now: start + 2_000 + TranscriptFocusLanding.landLimit - 1)
        #expect(landing.holdsPlace, "a tick before the deadline changes nothing")
        landing.expire(now: start + 2_000 + TranscriptFocusLanding.landLimit)
        #expect(!landing.holdsPlace)
        #expect(landing.deadline == nil)
    }

    @Test func aReplyThatNeverComesLetsThePlaceGoAfterTheServiceWouldHaveGivenUp() {
        var landing = aimed()
        #expect(landing.deadline == start + TranscriptFocusLanding.replyLimit)
        #expect(TranscriptFocusLanding.replyLimit > 30_000, "longer than the service's own 30-second timeout")
        landing.expire(now: start + TranscriptFocusLanding.replyLimit)
        #expect(!landing.holdsPlace)
        #expect(!landing.isActive)
    }

    @Test func layoutThatStallsOffScreenEndsAtTheDeadlineEvenWithBudgetLeft() {
        // A scroll that changes nothing (the row stays outside what the reader sees) brings no
        // more layout; the step at the deadline, or the tick, releases it.
        var landing = aimed()
        landing.replied(focus: "item.103", now: start)
        _ = landing.step(row: "block:7", frame: row(2_400, 2_480), in: screen, now: start + 100)
        #expect(landing.step(row: "block:7", frame: row(2_400, 2_480), in: screen, now: start + TranscriptFocusLanding.landLimit) == .none)
        #expect(!landing.holdsPlace)
    }

    @Test func aFailedJumpLetsThePlaceGo() {
        var landing = aimed()
        landing.readFailed()
        #expect(!landing.isActive)
        #expect(landing.deadline == nil)
    }

    @Test func retryingAFailedFocusedOpenAimsAtItsFocusAgain() {
        var landing = aimed()
        landing.readFailed()
        #expect(!landing.isActive)
        landing.retried(now: start + 40_000)
        #expect(landing.target == "item.103")
        #expect(landing.deadline == start + 40_000 + TranscriptFocusLanding.replyLimit)
        // The retry's reply names the focus, so it lands like the first try would have.
        landing.replied(focus: "item.103", now: start + 41_000)
        #expect(landing.target == "item.103")
    }

    @Test func retryingAFailedTurnJumpWaitsForItsReplyAgain() {
        var landing = TranscriptFocusLanding()
        landing.jumped(to: nil, now: start)
        landing.readFailed()
        landing.retried(now: start + 100)
        landing.replied(focus: "item.40", now: start + 200)
        #expect(landing.target == "item.40")
    }

    @Test func retryingAReadThatWasNoJumpAimsAtNothing() {
        // A reopened session or a page failed: its retry restores no focus.
        var landing = TranscriptFocusLanding()
        landing.readFailed()
        landing.retried(now: start)
        landing.replied(focus: "item.103", now: start + 100)
        #expect(!landing.isActive)
    }

    @Test func aRetryAfterTheReaderTookOverAimsAtNothing() {
        var landing = aimed()
        landing.readFailed()
        landing.readerTookOver()
        landing.retried(now: start + 100)
        #expect(!landing.isActive)
    }

    // MARK: Retries through the reader. No machine is connected, so every read fails at once.

    /// Waits for the read in flight to fail.
    private func failed(_ reading: TranscriptReading) async throws {
        for _ in 0..<200 where reading.loading { try await Task.sleep(for: .milliseconds(10)) }
        try #require(!reading.loading && reading.problem != nil)
    }

    @Test func retryingAFailedFocusedOpenThroughTheReaderAimsAtItsFocus() async throws {
        let model = ClientModel(now: { 1_000 })
        let live = ThreadModel(id: "thread")
        let reading = TranscriptReading()
        reading.jump(to: "item.103", model: model, live: live)
        try await failed(reading)
        #expect(!reading.landing.isActive, "a failed open holds nothing while it waits for Retry")
        reading.retry(model: model, live: live)
        #expect(reading.landing.target == "item.103")
    }

    @Test func aRebuildAfterAFailedFocusedOpenRetriesWithoutTheOldFocus() async throws {
        let model = ClientModel(now: { 1_000 })
        let live = ThreadModel(id: "thread")
        let reading = TranscriptReading()
        reading.jump(to: "item.103", model: model, live: live)
        try await failed(reading)
        // A recovery rebuild around another anchor replaces the request Retry sends.
        reading.rebuild(model: model, live: live, anchorItemId: "item.7")
        try await failed(reading)
        reading.retry(model: model, live: live)
        #expect(!reading.landing.isActive)
    }

    @Test func aPageAfterAFailedFocusedOpenRetriesWithoutTheOldFocus() async throws {
        let model = ClientModel(now: { 1_000 })
        let live = ThreadModel(id: "thread")
        let reading = TranscriptReading()
        reading.jump(to: "item.103", model: model, live: live)
        try await failed(reading)
        reading.read("older", model: model, live: live)
        try await failed(reading)
        reading.retry(model: model, live: live)
        #expect(!reading.landing.isActive, "paging is not held for a focus nobody asked for again")
    }

    @Test func aNewFocusStartsAFreshBudgetAndDeadline() {
        var landing = aimed()
        for _ in 0..<TranscriptFocusLanding.maxScrolls { _ = landing.step(row: "block:7", frame: nil, in: screen, now: start) }
        landing.jumped(to: "item.20", now: start + 5_000)
        #expect(landing.deadline == start + 5_000 + TranscriptFocusLanding.replyLimit)
        #expect(landing.step(row: "block:2", frame: nil, in: screen, now: start + 5_000) == .scroll(rowID: "block:2", anchor: nil))
    }

    @Test func aReplyNamingNoFocusLetsThePlaceGo() {
        let reading = TranscriptReading()
        reading.landing.jumped(to: "item.103", now: start)
        reading.applyReply(reply(focus: nil), operation: "item", now: start + 100)
        #expect(!reading.landing.holdsPlace)
    }

    @Test func aTurnJumpLandsOnTheItemItsReplyNames() {
        let reading = TranscriptReading()
        reading.landing.jumped(to: nil, now: start)
        #expect(!reading.landing.holdsPlace)
        reading.applyReply(reply(focus: "item.40"), operation: "turn", now: start + 100)
        #expect(reading.landing.target == "item.40")
        #expect(reading.landing.deadline == start + 100 + TranscriptFocusLanding.landLimit)
    }

    @Test func aPageReplyKeepsAFocusStillLanding() {
        let reading = TranscriptReading()
        reading.landing.jumped(to: "item.103", now: start)
        reading.applyReply(reply(focus: "item.103"), operation: "item", now: start + 100)
        reading.applyReply(reply(focus: nil), operation: "older", now: start + 200)
        #expect(reading.landing.target == "item.103")
    }

    @Test func aReopenedSessionOrRebuildIsNotAFocus() {
        // Both read an item window, but the reader's own offset is restored, not the item centred.
        let reading = TranscriptReading()
        reading.applyReply(reply(focus: "item.103"), operation: "item", now: start)
        #expect(!reading.landing.holdsPlace)
    }

    @Test func theReaderScrollingBeforeATurnsReplyKeepsTheirPlace() {
        var landing = TranscriptFocusLanding()
        landing.jumped(to: nil, now: start)
        landing.readerTookOver()
        landing.replied(focus: "item.40", now: start + 100)
        #expect(!landing.holdsPlace)
    }

    private func reply(focus: String?) -> TranscriptReadingReply {
        TranscriptReadingReply(active: true, hasOlder: true, hasNewer: true, joined: false, focus: focus, count: 200,
                               freshness: .current, evictedLeading: nil, evictedTrailing: nil, deleted: nil,
                               beforeSeq: nil, afterSeq: nil, beforeCount: nil, afterCount: nil, blockSeqs: nil)
    }
}
