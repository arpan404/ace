import Testing
@testable import Ace

@Suite struct ReviewReplyDraftTests {
    @Test(arguments: [String(repeating: "a", count: 4097), String(repeating: "🙂", count: 2049)])
    func oversizedRepliesCannotBeSentAsTruncatedText(_ text: String) {
        let draft = ReviewReplyDraft(text: text)
        #expect(!draft.canSubmit)
    }

    @Test(arguments: [String(repeating: "a", count: 4096), String(repeating: "🙂", count: 2048)])
    func repliesAtTheWireLimitCanBeSent(_ text: String) {
        #expect(ReviewReplyDraft(text: text).canSubmit)
    }

    @Test func refusalKeepsTheReplyForRetry() {
        var draft = ReviewReplyDraft(text: "Please keep this")
        draft.begin(id: "reply-1")
        draft.finish(ok: false)
        #expect(draft.text == "Please keep this")
        #expect(!draft.pending)
        #expect(draft.canSubmit)
    }

    @Test func successClearsOnlyTheSubmittedDraft() {
        var draft = ReviewReplyDraft(text: "First")
        draft.begin(id: "reply-1")
        #expect(draft.pending)
        #expect(!draft.canSubmit)
        draft.text = "Next reply"
        draft.finish(ok: true)
        #expect(draft.text == "Next reply")
        draft.begin(id: "reply-2")
        draft.finish(ok: true)
        #expect(draft.text.isEmpty)
    }
}
