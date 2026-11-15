import Testing
@testable import Ace

/// VoiceOver hears an answer that is still arriving as "Writing", and nothing once it is done or
/// its turn stopped. The words never depend on the answer's text, so a delta never re-reads it.
@Suite struct AnswerLivenessTests {
    @Test func anAnswerStillArrivingReadsAsWriting() {
        #expect(AnswerLiveness(streaming: true, complete: false).accessibilityValue == "Writing")
    }

    @Test func aFinishedAnswerReadsNothingMore() {
        #expect(AnswerLiveness(streaming: true, complete: true).accessibilityValue == "")
        #expect(AnswerLiveness(streaming: false, complete: true).accessibilityValue == "")
    }

    @Test func textLeftIncompleteByAStoppedTurnNoLongerReadsAsWriting() {
        #expect(AnswerLiveness(streaming: false, complete: false).accessibilityValue == "")
    }

    @Test func onlyAnAnswerStillArrivingIsLive() {
        #expect(AnswerLiveness(streaming: true, complete: false).live)
        #expect(!AnswerLiveness(streaming: true, complete: true).live)
        #expect(!AnswerLiveness(streaming: false, complete: false).live)
    }
}
