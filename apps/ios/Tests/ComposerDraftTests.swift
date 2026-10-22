import Testing
import Foundation
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
    @Test func aMessageOfOnlyFilesGoesButAnEmptyOneDoesNot() async {
        let draft = ComposerDraft()
        var sent: [String] = []
        await draft.submit(delivery: "queue") { text, _ in sent.append(text); return true }
        #expect(sent.isEmpty)
        await draft.submit(delivery: "queue", files: 1) { text, _ in sent.append(text); return true }
        #expect(sent == [""])
    }

    private func draftsFile() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("drafts-\(UUID().uuidString).json")
    }
    @Test func typedWordsComeBackAfterLeavingTheThreadAndAfterARelaunch() {
        let url = draftsFile()
        let key = ThreadDrafts.key(hostId: "host", threadId: "thread-a")
        let typing = ComposerDraft(saveDelay: .seconds(60))
        typing.follow(key, in: ThreadDrafts(url: url))
        typing.text = "half a thought"
        typing.flush() // leaving the thread
        let reopened = ComposerDraft()
        reopened.follow(key, in: ThreadDrafts(url: url)) // a new launch reads the file again
        #expect(reopened.text == "half a thought")
        let otherThread = ComposerDraft()
        otherThread.follow(ThreadDrafts.key(hostId: "host", threadId: "thread-b"), in: ThreadDrafts(url: url))
        #expect(otherThread.text.isEmpty)
        let otherMachine = ComposerDraft()
        otherMachine.follow(ThreadDrafts.key(hostId: "other-host", threadId: "thread-a"), in: ThreadDrafts(url: url))
        #expect(otherMachine.text.isEmpty)
    }
    @Test func typingIsSavedOnceItPausesWithoutLeaving() async throws {
        let url = draftsFile()
        let key = ThreadDrafts.key(hostId: "host", threadId: "thread")
        let draft = ComposerDraft(saveDelay: .milliseconds(10))
        draft.follow(key, in: ThreadDrafts(url: url))
        draft.text = "kept while typing"
        for _ in 0..<200 where ThreadDrafts(url: url).text(for: key).isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        #expect(ThreadDrafts(url: url).text(for: key) == "kept while typing")
    }
    @Test func aSentMessageLeavesNoDraftToSendAgainButARefusedOneKeepsIt() async {
        let url = draftsFile()
        let key = ThreadDrafts.key(hostId: "host", threadId: "thread")
        let draft = ComposerDraft(saveDelay: .seconds(60))
        draft.follow(key, in: ThreadDrafts(url: url))
        draft.text = "ship it"
        await draft.submit(delivery: "follow") { _, _ in false }
        draft.flush()
        #expect(ThreadDrafts(url: url).text(for: key) == "ship it")
        await draft.submit(delivery: "follow") { _, _ in true }
        // No flush: the app may be killed right after the send is saved.
        #expect(ThreadDrafts(url: url).text(for: key).isEmpty)
    }
    @Test func theOldestDraftsFallOffPastTheLimit() {
        let url = draftsFile()
        let drafts = ThreadDrafts(url: url)
        for index in 0...ThreadDrafts.limit { drafts.save("words \(index)", for: "key-\(index)") }
        let reread = ThreadDrafts(url: url)
        #expect(reread.text(for: "key-0").isEmpty)
        #expect(reread.text(for: "key-1") == "words 1")
        #expect(reread.text(for: "key-\(ThreadDrafts.limit)") == "words \(ThreadDrafts.limit)")
    }
}
