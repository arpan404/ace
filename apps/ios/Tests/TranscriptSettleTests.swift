import Testing
@testable import Ace

/// When the transcript is shown again after a thread opens or an older page lands: once what it
/// draws has held still for two frames, or a quarter second at most.
@Suite struct TranscriptSettleTests {
    @Test func aFeedThatHoldsStillForTwoFramesIsShown() {
        var settle = TranscriptSettle(at: 0)
        #expect(settle.frame([2_000, 1_400], at: 0.016) == .waiting, "the first frame has nothing to compare with")
        #expect(settle.frame([2_000, 1_400], at: 0.033) == .waiting, "one still frame isn't enough")
        #expect(settle.frame([2_000, 1_400], at: 0.050) == .settled)
    }

    @Test func aChangeStartsTheCountAgain() {
        var settle = TranscriptSettle(at: 0)
        _ = settle.frame([2_000, 1_400], at: 0.016)
        _ = settle.frame([2_000, 1_400], at: 0.033)
        #expect(settle.frame([2_310, 1_400], at: 0.050) == .waiting, "the content grew")
        #expect(settle.frame([2_310, 1_710], at: 0.066) == .waiting, "the offset followed it")
        #expect(settle.frame([2_310, 1_710], at: 0.083) == .waiting)
        #expect(settle.frame([2_310, 1_710], at: 0.100) == .settled)
    }

    @Test func movesUnderHalfAPointCountAsStill() {
        var settle = TranscriptSettle(at: 0)
        _ = settle.frame([2_000], at: 0.016)
        _ = settle.frame([2_000.3], at: 0.033)
        #expect(settle.frame([2_000.1], at: 0.050) == .settled)
    }

    @Test func aFeedNotYetWhereItBelongsIsNotShown() {
        var settle = TranscriptSettle(at: 0)
        _ = settle.frame([2_000, 1_400], at: 0.016)
        _ = settle.frame([2_000, 1_400], at: 0.033)
        #expect(settle.frame([2_000, 1_400], placed: false, at: 0.050) == .waiting, "short of the end")
        #expect(settle.frame([2_000, 1_400], at: 0.066) == .waiting, "placed counts from here")
        #expect(settle.frame([2_000, 1_400], at: 0.083) == .settled)
    }

    @Test func aFeedThatNeverSettlesIsShownAfterAQuarterSecond() {
        var settle = TranscriptSettle(at: 1)
        var outcome = TranscriptSettle.Outcome.waiting
        var height = 2_000.0
        var time = 1.0
        while outcome == .waiting, time < 2 {
            time += 0.016
            height += 40
            outcome = settle.frame([height], at: time)
        }
        #expect(outcome == .capped)
        #expect(time >= 1.25 && time < 1.27, "shown at the cap, not before or long after: \(time)")
    }
}
