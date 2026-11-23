import Foundation

/// The suggestions picked to commit together on one pull request, all shown at one head. Every
/// page of that pull request (its Timeline, each file's Code) adds to the same batch.
@MainActor @Observable final class ForgeSuggestionBatch {
    /// The most one commit takes (`suggestions.apply` names at most 100 comments).
    static let limit = 100

    private(set) var ids: [Int] = []
    /// The head every picked suggestion was shown at; nil while the batch is empty.
    private(set) var head: String?
    /// The commit message, as the bridge prefills it.
    private(set) var message = ""

    func contains(_ commentId: Int, at head: String) -> Bool { self.head == head && ids.contains(commentId) }

    /// Add a suggestion, or take it out. One shown at another head starts the batch again: a
    /// commit names one head. Answers why it couldn't be added, or nil.
    func toggle(_ commentId: Int, _ suggestion: ForgeComment.Suggestion) -> String? {
        if head != suggestion.headSha { ids = []; head = suggestion.headSha }
        message = suggestion.batchMessage
        if let index = ids.firstIndex(of: commentId) {
            ids.remove(at: index)
        } else if ids.count >= Self.limit {
            return "A batch holds up to \(Self.limit) suggestions. Commit these first, then add more."
        } else {
            ids.append(commentId)
        }
        if ids.isEmpty { head = nil }
        return nil
    }

    func clear() { ids = []; head = nil }

    /// A page read at `head`: a batch picked at another head can't be committed, so it goes.
    func keep(at head: String) { if self.head != nil, self.head != head { clear() } }

    /// Suggestions now committed leave the batch; the rest stay.
    func committed(_ commentIds: [Int]) {
        ids.removeAll(where: commentIds.contains)
        if ids.isEmpty { head = nil }
    }
}

/// One suggestion batch per pull request, kept while the app runs so its pages share it.
@MainActor final class ForgeSuggestionBatches {
    private var batches: [ForgePullTarget: ForgeSuggestionBatch] = [:]

    func batch(for target: ForgePullTarget) -> ForgeSuggestionBatch {
        if let batch = batches[target] { return batch }
        let batch = ForgeSuggestionBatch()
        batches[target] = batch
        return batch
    }
}
