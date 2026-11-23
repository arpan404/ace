import Foundation
import Testing
@testable import Ace

@MainActor @Suite struct ForgeSuggestionBatchTests {
    private let acme = ForgeRepository(forge: "github", host: "github.com", owner: "acme", name: "ace")
    private func suggestion(at head: String) -> ForgeComment.Suggestion {
        ForgeComment.Suggestion(commit: true, headSha: head, message: "Apply suggestion from @mira",
                                batchMessage: "Apply suggestions from code review", agent: "Apply mira's suggested change")
    }

    @Test func everyPageOfOnePullRequestCommitsFromTheSameBatch() {
        let batches = ForgeSuggestionBatches()
        let pull = ForgePullTarget(project: "ace", number: 245, repository: acme)
        // Two Code pages of #245 pick one suggestion each.
        _ = batches.batch(for: pull).toggle(2456, suggestion(at: "a1"))
        _ = batches.batch(for: pull).toggle(2457, suggestion(at: "a1"))
        #expect(batches.batch(for: pull).ids == [2456, 2457])
        #expect(batches.batch(for: pull).message == "Apply suggestions from code review")
        // Another pull request keeps its own.
        #expect(batches.batch(for: ForgePullTarget(project: "ace", number: 31, repository: acme)).ids.isEmpty)
    }

    @Test func aHundredAndFirstSuggestionIsRefusedWithTheReason() {
        let batch = ForgeSuggestionBatch()
        for id in 1...100 { #expect(batch.toggle(id, suggestion(at: "a1")) == nil) }
        #expect(batch.toggle(101, suggestion(at: "a1")) == "A batch holds up to 100 suggestions. Commit these first, then add more.")
        #expect(batch.ids.count == 100)
        #expect(!batch.contains(101, at: "a1"))
        // A full batch still lets one go.
        #expect(batch.toggle(100, suggestion(at: "a1")) == nil)
        #expect(batch.ids.count == 99)
    }

    @Test func aBatchNamesOneHeadAndANewHeadStartsItAgain() {
        let batch = ForgeSuggestionBatch()
        _ = batch.toggle(1, suggestion(at: "a1"))
        _ = batch.toggle(2, suggestion(at: "b2"))
        #expect(batch.ids == [2])
        #expect(batch.head == "b2")
        // A page read at another head drops a batch it can no longer commit.
        batch.keep(at: "c3")
        #expect(batch.ids.isEmpty)
        #expect(batch.head == nil)
    }

    @Test func committedSuggestionsLeaveTheBatchAndTheRestStay() {
        let batch = ForgeSuggestionBatch()
        for id in [1, 2, 3] { _ = batch.toggle(id, suggestion(at: "a1")) }
        batch.committed([1, 3])
        #expect(batch.ids == [2])
        #expect(batch.head == "a1")
        batch.committed([2])
        #expect(batch.head == nil)
    }
}
