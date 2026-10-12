import Testing
@testable import Ace

@Suite struct DisplayTextTests {
    @Test func displayBudgetsNeverSplitEmojiCombiningMarksOrJoinedEmoji() {
        #expect(DisplayText.tail("😀" + String(repeating: "x", count: 8191), limit: 8192) == String(repeating: "x", count: 8191))
        #expect(DisplayText.head("ab😀c", limit: 3) == "ab…")
        #expect(DisplayText.head("abe\u{301}c", limit: 3) == "ab…")
        #expect(DisplayText.tail("a👨‍👩‍👧‍👦xyz", limit: 7) == "xyz")
        #expect(DisplayText.head("😀", limit: 2) == "😀")
        #expect(DisplayText.tail("e\u{301}", limit: 2) == "e\u{301}")
    }
}
