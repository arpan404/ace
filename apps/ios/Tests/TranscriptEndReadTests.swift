import Testing
@testable import Ace

@Suite struct TranscriptEndReadTests {
    private func facts(fromEnd: Double, moving: Bool, windowOpen: Bool = true, joined: Bool = true,
                       followsEnd: Bool, loading: Bool = false) -> TranscriptEndRead.Facts {
        .init(fromEnd: fromEnd, viewport: 800, moving: moving, windowOpen: windowOpen, joined: joined,
              followsEnd: followsEnd, loading: loading, atEndSlack: 32)
    }

    @Test func aFlingTurningNearTheEndSendsNothing() {
        // Following the end, the reader drags half a screen up and back down.
        #expect(TranscriptEndRead.decide(facts(fromEnd: 400, moving: true, followsEnd: true)) == .none)
        #expect(TranscriptEndRead.decide(facts(fromEnd: 0, moving: true, followsEnd: true)) == .none)
        #expect(TranscriptEndRead.decide(facts(fromEnd: 0, moving: false, followsEnd: true)) == .none)
    }

    @Test func readingAScreenAwayHoldsOnce() {
        #expect(TranscriptEndRead.decide(facts(fromEnd: 900, moving: true, followsEnd: true)) == .hold)
        // Held already: going further sends nothing more.
        #expect(TranscriptEndRead.decide(facts(fromEnd: 3_000, moving: true, followsEnd: false)) == .none)
    }

    @Test func aFirstReadAwayFromTheEndOpensTheWindow() {
        #expect(TranscriptEndRead.decide(facts(fromEnd: 900, moving: true, windowOpen: false, followsEnd: true)) == .hold)
        #expect(TranscriptEndRead.decide(facts(fromEnd: 100, moving: false, windowOpen: false, followsEnd: true)) == .hold)
    }

    @Test func comingToRestAwayFromTheEndHolds() {
        #expect(TranscriptEndRead.decide(facts(fromEnd: 200, moving: false, followsEnd: true)) == .hold)
    }

    @Test func aHeldWindowFollowsAgainOnlyOnceTheReaderStopsAtTheEnd() {
        #expect(TranscriptEndRead.decide(facts(fromEnd: 0, moving: true, followsEnd: false)) == .none)
        #expect(TranscriptEndRead.decide(facts(fromEnd: 0, moving: false, followsEnd: false)) == .follow)
        #expect(TranscriptEndRead.decide(facts(fromEnd: 300, moving: false, followsEnd: false)) == .none)
    }

    @Test func aWindowApartFromTheTailNeverFollows() {
        #expect(TranscriptEndRead.decide(facts(fromEnd: 0, moving: false, joined: false, followsEnd: false)) == .none)
    }

    @Test func nothingIsSentWhileAReadIsInFlight() {
        #expect(TranscriptEndRead.decide(facts(fromEnd: 900, moving: true, followsEnd: true, loading: true)) == .none)
        #expect(TranscriptEndRead.decide(facts(fromEnd: 0, moving: false, followsEnd: false, loading: true)) == .none)
    }
}
