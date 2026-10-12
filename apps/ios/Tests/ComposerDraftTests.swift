import Testing
@testable import Ace

@Suite @MainActor struct ComposerDraftTests {
    @Test func aDraftStaysVisibleUntilPersistenceConfirmsItAndSurvivesRejection() async throws {
        let draft = ComposerDraft()
        draft.text = "Preserve this exact input"
        var release: CheckedContinuation<Bool, Never>?
        let submit = Task {
            await draft.submit(delivery: "queue") { _, _ in
                await withCheckedContinuation { release = $0 }
            }
        }
        for _ in 0..<100 where release == nil { await Task.yield() }
        let continuation = try #require(release)
        #expect(draft.text == "Preserve this exact input")
        #expect(draft.saving)
        continuation.resume(returning: false)
        await submit.value
        #expect(draft.text == "Preserve this exact input")
        #expect(!draft.saving)
        await draft.submit(delivery: "queue") { _, _ in true }
        #expect(draft.text.isEmpty)
    }
    @Test func persistenceDoesNotEraseEditsMadeWhileSaving() async {
        let draft = ComposerDraft()
        draft.text = "Original"
        await draft.submit(delivery: "queue") { _, _ in
            draft.text = "New edits"
            return true
        }
        #expect(draft.text == "New edits")
    }
}
