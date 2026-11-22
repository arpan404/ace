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

    @Test func everyPieceCarriesTheLinkDefinitionsSoItsReferencesResolve() {
        let text = "See [the plan][plan].\n\n| a | b |\n|---|---|\n| [it][plan] | 2 |\n\n[plan]: https://example.com\n  \"The plan\"\n"
        let defined = "\n\n[plan]: https://example.com\n  \"The plan\""
        #expect(MarkdownBlocks.split(text) == [
            .prose("See [the plan][plan]." + defined),
            .table("| a | b |\n|---|---|\n| [it][plan] | 2 |" + defined),
        ])
    }

    @Test func aDefinitionArrivingLateInAStreamLeavesTheTableCut() {
        let splitter = MarkdownBlocks.Splitter()
        let table = "| a | b |\n|---|---|\n| [x][1] | 2 |"
        #expect(splitter.split("Intro\n\n" + table + "\n\n") == [.prose("Intro"), .table(table)])
        #expect(splitter.split("Intro\n\n" + table + "\n\n[1]: https://example.com") == [
            .prose("Intro\n\n[1]: https://example.com"), .table(table + "\n\n[1]: https://example.com"),
        ])
    }

    @Test func aLineShapedLikeADefinitionInsideAParagraphStaysItsText() {
        let text = "Intro line\n[a]: not a definition\n\n| a | b |\n|---|---|"
        #expect(MarkdownBlocks.split(text) == [.prose("Intro line\n[a]: not a definition"), .table("| a | b |\n|---|---|")])
    }

    @Test func textDefiningAFootnoteIsNeverCut() {
        let footnote = "| a | b |\n|---|---|\n| 1 | 2[^n] |\n\n[^n]: a note"
        #expect(MarkdownBlocks.split(footnote) == [.prose(footnote)])
    }

    @Test func textThatChangesTheLineAfterAClosedTableIsReadAgainFromThatTable() {
        let splitter = MarkdownBlocks.Splitter()
        _ = splitter.split("| a |\n|---|\n| 1 |\nfoo\nx")
        // Same start, but the line that ended the table is now one of its rows.
        let replaced = "| a |\n|---|\n| 1 |\n| 2 |\nx"
        #expect(splitter.split(replaced) == MarkdownBlocks.split(replaced))
        #expect(splitter.split(replaced) == [.table("| a |\n|---|\n| 1 |\n| 2 |"), .prose("x")])
    }

    @Test func textThatChangesATablesDelimiterRowIsReadAgainFromBeforeIt() {
        let splitter = MarkdownBlocks.Splitter()
        _ = splitter.split("| z |\n|---|\n\nIntro\n| a | b |\n|---|---|\n| 1")
        // The rule under the header is no longer one: the intro and both lines are one paragraph.
        let replaced = "| z |\n|---|\n\nIntro\n| a | b |\n|-x-|---|\n| 1"
        #expect(splitter.split(replaced) == MarkdownBlocks.split(replaced))
    }

    @Test func aStreamSplitAsItGrowsCutsAsTheWholeTextDoesAtEveryStep() {
        let answer = """
        Where things stand, see [the plan][plan]:

        | Area | State |
        | --- | :-: |
        | Recording | done |
        | Replay | `not | started` |
        After the table.

        ```
        | not | a |
        |---|---|
        ```

        name | state
        ---|---:
        recorder | done

        [plan]: https://example.com
        - a list | item
        | x | y |
        |---|---|
        """
        let splitter = MarkdownBlocks.Splitter()
        var grown = ""
        for character in answer {
            grown.append(character)
            #expect(splitter.split(grown) == MarkdownBlocks.split(grown), "at \(grown.count)")
        }
        // Text that doesn't carry on from the last (an edit) is read whole again.
        let edited = answer.replacingOccurrences(of: "Recording", with: "Capture")
        #expect(splitter.split(edited) == MarkdownBlocks.split(edited))
    }

    @Test func aTableEndsAtTheFirstLineWithoutAPipe() {
        let text = "| a | b |\n|---|---|\n| 1 | 2 |\nAfter it."
        #expect(MarkdownBlocks.split(text) == [.table("| a | b |\n|---|---|\n| 1 | 2 |"), .prose("After it.")])
    }

    @Test func aStreamingTableIsATableAsSoonAsItsDelimiterRowArrives() {
        #expect(MarkdownBlocks.split("Intro\n\n| a | b |\n|--|") == [.prose("Intro\n\n| a | b |\n|--|")])
        #expect(MarkdownBlocks.split("Intro\n\n| a | b |\n|--|--") == [.prose("Intro"), .table("| a | b |\n|--|--")])
    }

    @Test func aListItemRightAfterATableStaysProseEvenWithAPipeInIt() {
        let text = "| a | b |\n|---|---|\n| 1 | 2 |\n- Follow up on A | B\n1. Then C | D"
        #expect(MarkdownBlocks.split(text) == [.table("| a | b |\n|---|---|\n| 1 | 2 |"), .prose("- Follow up on A | B\n1. Then C | D")])
    }

    @Test func aTableWithWindowsLineEndingsIsATable() {
        let text = "Intro\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n\r\nAfter."
        #expect(MarkdownBlocks.split(text) == [.prose("Intro"), .table("| a | b |\n|---|---|\n| 1 | 2 |"), .prose("After.")])
    }

    @Test func bodyRowsNeedOnlyAPipeSomewhereNotAtTheirEdges() {
        let text = "| a | b |\n|---|---|\n1 | 2\n| 3 | 4\n5 | 6 |\nAfter."
        #expect(MarkdownBlocks.split(text) == [.table("| a | b |\n|---|---|\n1 | 2\n| 3 | 4\n5 | 6 |"), .prose("After.")])
    }

    @Test func escapedPipesStayInsideTheirCell() {
        let cells = MarkdownBlocks.cells("| `a \\| b` | c |").map(String.init)
        #expect(cells == [" `a \\| b` ", " c "])
    }
}
