import Testing
@testable import Ace

/// Answers are cut so that their tables, and only those, are drawn by ace's own sideways
/// scroller; everything else reaches markit as it was written.
@Suite struct MarkdownBlocksTests {
    @Test func aTableBetweenParagraphsIsTakenOutWithItsRows() {
        let text = """
        Where things stand:

        | Area | main today |
        | --- | :-- |
        | Recording | `packages/browser/src/recording.ts` writes frames |
        | Replay | not started |

        Next I'll wire the replay.
        """
        #expect(MarkdownBlocks.split(text) == [
            .prose("Where things stand:"),
            .table("""
            | Area | main today |
            | --- | :-- |
            | Recording | `packages/browser/src/recording.ts` writes frames |
            | Replay | not started |
            """),
            .prose("Next I'll wire the replay."),
        ])
    }

    @Test func aTableWithoutEdgePipesThatEndsAParagraphIsATable() {
        let text = "Summary\nname | state\n---|---:\nrecorder | done"
        #expect(MarkdownBlocks.split(text) == [.prose("Summary"), .table("name | state\n---|---:\nrecorder | done")])
    }

    @Test func textWithoutATableIsLeftWhole() {
        let text = "A pipe | in prose\n\n- a list\n- with --- dashes"
        #expect(MarkdownBlocks.split(text) == [.prose(text)])
    }

    @Test func aHeaderWhoseDelimiterHasADifferentCountIsNotATable() {
        let text = "| a | b |\n| --- |\n| 1 | 2 |"
        #expect(MarkdownBlocks.split(text) == [.prose(text)])
    }

    @Test func aPipedLineOverASetextUnderlineStaysAHeading() {
        let text = "a | b\n---"
        #expect(MarkdownBlocks.split(text) == [.prose(text)])
    }

    @Test func aTableInsideACodeFenceStaysCode() {
        let text = """
        ```markdown
        | a | b |
        |---|---|
        | 1 | 2 |
        ```
        """
        #expect(MarkdownBlocks.split(text) == [.prose(text)])
    }

    @Test func aTableAfterAClosedFenceIsATable() {
        let text = "~~~\ncode\n~~~\n\n| a | b |\n|---|---|\n| 1 | 2 |"
        #expect(MarkdownBlocks.split(text) == [.prose("~~~\ncode\n~~~"), .table("| a | b |\n|---|---|\n| 1 | 2 |")])
    }

    @Test func tablesInListsAndQuotesStayWithTheirProse() {
        let list = "- item\n  | a | b |\n  |---|---|\n  | 1 | 2 |"
        let lazy = "- item\n| a | b |\n|---|---|"
        let quote = "> | a | b |\n> |---|---|"
        #expect(MarkdownBlocks.split(list) == [.prose(list)])
        #expect(MarkdownBlocks.split(lazy) == [.prose(lazy)])
        #expect(MarkdownBlocks.split(quote) == [.prose(quote)])
    }

    @Test func textDefiningReferencesIsNeverCut() {
        let text = "See [the plan][plan].\n\n| a | b |\n|---|---|\n\n[plan]: https://example.com\n"
        let footnote = "| a | b |\n|---|---|\n| 1 | 2[^n] |\n\n[^n]: a note"
        #expect(MarkdownBlocks.split(text) == [.prose(text)])
        #expect(MarkdownBlocks.split(footnote) == [.prose(footnote)])
    }

    @Test func aTableEndsAtTheFirstLineWithoutAPipe() {
        let text = "| a | b |\n|---|---|\n| 1 | 2 |\nAfter it."
        #expect(MarkdownBlocks.split(text) == [.table("| a | b |\n|---|---|\n| 1 | 2 |"), .prose("After it.")])
    }

    @Test func aStreamingTableIsATableAsSoonAsItsDelimiterRowArrives() {
        #expect(MarkdownBlocks.split("Intro\n\n| a | b |\n|--|") == [.prose("Intro\n\n| a | b |\n|--|")])
        #expect(MarkdownBlocks.split("Intro\n\n| a | b |\n|--|--") == [.prose("Intro"), .table("| a | b |\n|--|--")])
    }

    @Test func escapedPipesStayInsideTheirCell() {
        let cells = MarkdownBlocks.cells("| `a \\| b` | c |").map(String.init)
        #expect(cells == [" `a \\| b` ", " c "])
    }
}
