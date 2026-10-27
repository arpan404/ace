import Foundation
import Testing
@testable import Ace

/// Previous message through `ComposerRecaller`, which the composer calls, on a real `ComposerDraft`.
@Suite @MainActor struct ComposerRecallTests {
    private let sent = ["Now run lint", "Fix the flaky test"]
    private func fetch(_ older: Int) async -> String? { sent.indices.contains(older) ? sent[older] : nil }

    @Test func walkingBackKeepsWhatWasTypedBeforeTheFirstRecall() async {
        let draft = ComposerDraft()
        draft.text = "Also check CI"
        let recaller = ComposerRecaller()
        #expect(await recaller.recall(into: draft, fetch: fetch) == .recalled)
        #expect(draft.text == "Also check CI\n\nNow run lint")
        #expect(await recaller.recall(into: draft, fetch: fetch) == .recalled)
        #expect(draft.text == "Also check CI\n\nFix the flaky test")
        #expect(await recaller.recall(into: draft, fetch: fetch) == .none("That was the first message"))
        #expect(draft.text == "Also check CI\n\nFix the flaky test")
    }

    @Test func wordsTypedWhileTheMessageIsReadAreNeverReplaced() async {
        let draft = ComposerDraft()
        let recaller = ComposerRecaller()
        let outcome = await recaller.recall(into: draft) { older in
            draft.text = "typed meanwhile"
            return sent[older]
        }
        #expect(outcome == .skipped)
        #expect(draft.text == "typed meanwhile")
    }

    @Test func typingAfterARecallStartsAgainFromTheLatestAfterTheNewWords() async {
        let draft = ComposerDraft()
        let recaller = ComposerRecaller()
        _ = await recaller.recall(into: draft, fetch: fetch)
        #expect(draft.text == "Now run lint")
        draft.text += " and tests"
        _ = await recaller.recall(into: draft, fetch: fetch)
        #expect(draft.text == "Now run lint and tests\n\nNow run lint")
    }
}

/// Words handed back for a thread land in its saved draft after what it held, and stay given
/// (unacknowledged) when they can't be saved.
@Suite @MainActor struct DraftWordsTests {
    @Test func givenWordsGoAfterTheSavedDraftAndAreOnDisk() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("drafts-\(UUID().uuidString).json")
        let drafts = ThreadDrafts(url: url)
        drafts.save("Half a thought", for: "host\u{0}thread")
        #expect(drafts.give("Ship the release notes", for: "host\u{0}thread"))
        #expect(ThreadDrafts(url: url).text(for: "host\u{0}thread") == "Half a thought\n\nShip the release notes")
    }

    @Test func wordsThatCantBeSavedAreReportedSoTheirRecordIsKept() throws {
        let blocked = FileManager.default.temporaryDirectory.appendingPathComponent("blocked-\(UUID().uuidString)")
        try Data().write(to: blocked)
        // A draft file whose folder is a plain file can't be written.
        let drafts = ThreadDrafts(url: blocked.appendingPathComponent("drafts.json"))
        #expect(!drafts.give("Ship the release notes", for: "host\u{0}thread"))
    }
}
