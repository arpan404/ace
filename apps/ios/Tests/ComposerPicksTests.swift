import Testing
import Foundation
@testable import Ace

@Suite @MainActor struct ComposerPicksTests {
    private func review(at start: Int) -> ComposerPick {
        ComposerPick(start: start, end: start + 6, label: "Review",
                     reference: .object(["label": .string("Review"), "catalog": .object(["name": .string("review")])]))
    }

    @Test func aDeletedPickNeverComesBackWhenItsWordIsTypedAgain() {
        let draft = ComposerDraft()
        draft.text = "Review "
        draft.add(review(at: 0))
        draft.text = ""
        draft.text = "Review the diff"
        #expect(draft.picks.isEmpty)
    }

    @Test func typingBeforeAPickMovesItAndTypingInsideItDropsIt() {
        let draft = ComposerDraft()
        draft.text = "Review this"
        draft.add(review(at: 0))
        draft.text = "Please Review this"
        #expect(draft.picks.picks.map(\.start) == [7])
        draft.text = "Please Revew this"
        #expect(draft.picks.isEmpty)
    }

    @Test func picksAreKeptWithTheDraftAndComeBackWithIt() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("picks-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let store = ThreadDrafts(url: url)
        let first = ComposerDraft(saveDelay: .zero)
        first.follow("thread", in: store)
        first.text = "Review this"
        first.add(review(at: 0))
        first.flush()
        let again = ComposerDraft()
        again.follow("thread", in: ThreadDrafts(url: url))
        #expect(again.text == "Review this")
        #expect(again.picks.picks.map(\.label) == ["Review"])
    }

    @Test func theWordAtTheCaretSkipsAnEmojiAsTheWebDoes() {
        #expect(ComposerTrigger.at("hi😀@foo", caret: ("hi😀@foo" as NSString).length) == nil)
        #expect(ComposerTrigger.at("hi 😀 @foo", caret: ("hi 😀 @foo" as NSString).length)?.query == "foo")
        let long = "@" + String(repeating: "a", count: 300)
        #expect(ComposerTrigger.at(long, caret: (long as NSString).length) == nil)
    }

    @Test func aNewProjectLeavesTheOldProjectsPicksBehind() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("new-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let drafts = NewThreadDraftModel(store: NewThreadDraftStore(url: url))
        drafts.edit { $0.projectId = "one"; $0.text = "Review it" }
        drafts.add(review(at: 0))
        #expect(drafts.draft.picks?.isEmpty == false)
        drafts.edit { $0.projectId = "two" }
        #expect(drafts.draft.picks == nil)
    }
}
