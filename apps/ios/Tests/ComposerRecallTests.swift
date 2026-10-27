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
