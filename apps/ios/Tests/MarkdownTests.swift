import Testing
@testable import Ace

@Suite struct MarkdownTests {
    @Test func proseListsAndClosedFencesBecomeTheirOwnBlocks() {
        let text = """
        ## Result
        Orphan cleanup now records the **start time**
        and owner.

        - `ace stop` interrupts the tree
        - `ace stop --all` keeps to our processes
          started by ace

        ```ts
        if (owner.startedAt !== kernel.startedAt) return;
        ```
        > Never kill a reused PID.

        ---
        3. Third
        4. Fourth
        """
        #expect(Markdown.blocks(text) == [
            .heading(level: 2, text: "Result"),
            .paragraph("Orphan cleanup now records the **start time**\nand owner."),
            .list(ordered: false, start: 1, items: ["`ace stop` interrupts the tree", "`ace stop --all` keeps to our processes\nstarted by ace"]),
            .code(language: "ts", text: "if (owner.startedAt !== kernel.startedAt) return;"),
            .quote("Never kill a reused PID."),
            .rule,
            .list(ordered: true, start: 3, items: ["Third", "Fourth"]),
        ])
    }
    @Test func aFenceStillStreamingStaysCodeUntilItCloses() {
        #expect(Markdown.blocks("Run this:\n```sh\nbun run test\n# heading-looking line") == [
            .paragraph("Run this:"),
            .code(language: "sh", text: "bun run test\n# heading-looking line"),
        ])
        #expect(Markdown.blocks("````\n```\nnested\n````\nafter") == [.code(language: "", text: "```\nnested"), .paragraph("after")])
    }
    @Test func hashesWithoutASpaceAndLoneDashesStayProse() {
        #expect(Markdown.blocks("#hashtag\n-not a list") == [.paragraph("#hashtag\n-not a list")])
    }
    @Test func comparisonTablesKeepCellBoundariesAndFollowingProse() {
        #expect(Markdown.blocks("Before\n\n| Area | Result |\n| --- | :---: |\n| UI | **Fixed** |\n| Code | `a|b` and a\\|b |\n\nAfter") == [
            .paragraph("Before"),
            .table(headers: ["Area", "Result"], rows: [["UI", "**Fixed**"], ["Code", "`a|b` and a|b"]]),
            .paragraph("After"),
        ])
        #expect(Markdown.blocks("```\n| Raw | Table |\n| --- | --- |\n```") == [.code(language: "", text: "| Raw | Table |\n| --- | --- |")])
    }
    @Test func streamingALongParagraphOnlyChangesItsLastPiece() {
        let sentence = "Next step: wire the safe kill-all filters. "
        let text = String(repeating: sentence, count: 120)
        let before = Markdown.pieces(text, size: 400)
        let after = Markdown.pieces(text + "More", size: 400)
        #expect(before.count > 2)
        #expect(Array(after.prefix(before.count - 1)) == Array(before.dropLast()))
        #expect(after.last?.hasSuffix("More") == true)
        // Nothing is lost between pieces: they cut only at the space after a sentence.
        #expect(after.joined(separator: " ") == text + "More")
    }
    @Test func aShortParagraphStaysWhole() {
        #expect(Markdown.pieces("One sentence. Two sentences.") == ["One sentence. Two sentences."])
        #expect(Markdown.pieces("") == [""])
    }
}
