import Testing
@testable import Ace

/// VoiceOver hears an answer still arriving as the bridge's word ("Writing") on a status ahead of
/// its text, and no status once the answer is done or its turn stopped. The status never depends
/// on the answer's text, so a delta never brings it back to be read again.
@Suite struct AnswerLivenessTests {
    @Test func anAnswerStillArrivingHasTheBridgesWordAsItsStatus() {
        #expect(AnswerLiveness(streaming: true, complete: false, writing: "Writing").status == "Writing")
    }

    @Test func aFinishedAnswerHasNoStatus() {
        #expect(AnswerLiveness(streaming: true, complete: true, writing: "Writing").status == nil)
        #expect(AnswerLiveness(streaming: false, complete: true, writing: nil).status == nil)
    }

    @Test func textLeftIncompleteByAStoppedTurnHasNoStatus() {
        #expect(AnswerLiveness(streaming: false, complete: false, writing: nil).status == nil)
    }

    @Test func onlyAnAnswerStillArrivingIsLive() {
        #expect(AnswerLiveness(streaming: true, complete: false, writing: "Writing").live)
        #expect(!AnswerLiveness(streaming: true, complete: true, writing: "Writing").live)
        #expect(!AnswerLiveness(streaming: false, complete: false, writing: nil).live)
    }
}
