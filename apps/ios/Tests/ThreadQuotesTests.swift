import Foundation
import Testing
@testable import Ace

/// What the next message replies to reaches the composer (`bridge/thread-quotes.ts`), and the
/// chip names the quotes as the person reads them.
@MainActor @Suite struct ThreadQuotesTests {
    private func apply(_ json: String, to screen: ThreadScreenModel) throws {
        let patch = try JSONDecoder().decode(BridgePatch.self, from: Data(json.utf8))
        guard case .screen(_, _, let screenPatch) = patch else { Issue.record("Expected a screen patch"); return }
        screen.apply(screenPatch)
    }

    @Test func quotesReachTheComposerAndAVisitsQuotesGoWithIt() throws {
        let screen = ThreadScreenModel()
        try apply(#"{"type":"thread.quotes","threadId":"t","epoch":1,"items":[{"id":"q1","text":"the guard"}],"full":true,"kept":[{"id":"q1","text":"the guard","before":"It can double as ","after":"."}]}"#, to: screen)
        #expect(screen.quotes.map(\.text) == ["the guard"])
        #expect(screen.quotesFull)
        #expect(screen.keptQuotes == [DraftQuote(id: "q1", text: "the guard", before: "It can double as ", after: ".")])
        // The bridge says the thread's quotes again on the next visit; until then none show, and
        // none are known, so the draft never keeps an empty list over them.
        screen.revisit()
        #expect(screen.quotes.isEmpty)
        #expect(!screen.quotesFull)
        #expect(screen.keptQuotes == nil)
    }

    @Test func theChipNamesOneQuoteByItsWordsAndSeveralByCount() {
        #expect(QuoteChips.label([QuoteChip(id: "a", text: "double as\nthe guard")]) == "Replying to “double as the guard”")
        #expect(QuoteChips.label([QuoteChip(id: "a", text: "x"), QuoteChip(id: "b", text: "y"), QuoteChip(id: "c", text: "z")]) == "Replying to 3 quotes")
    }
}
