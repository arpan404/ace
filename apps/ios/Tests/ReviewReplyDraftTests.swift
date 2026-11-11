import Testing
@testable import Ace

@Suite struct ReviewReplyDraftTests {
    @Test func refusalKeepsTheReplyForRetry() {
        var draft = ReviewReplyDraft(text: "Please keep this")
        draft.begin(id: "reply-1")
        draft.finish(ok: false)
        #expect(draft.text == "Please keep this")
        #expect(!draft.pending)
    }

    @Test func successClearsOnlyTheSubmittedDraft() {
        var draft = ReviewReplyDraft(text: "First")
        draft.begin(id: "reply-1")
        #expect(draft.pending)
        draft.text = "Next reply"
        draft.finish(ok: true)
        #expect(draft.text == "Next reply")
        draft.begin(id: "reply-2")
        draft.finish(ok: true)
        #expect(draft.text.isEmpty)
    }
}
