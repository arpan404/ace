import Foundation
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
        #expect(after.dropLast().map(\.offset) == before.dropLast().map(\.offset))
        #expect(after.dropLast().map(\.text) == before.dropLast().map(\.text))
        #expect(after.last?.text.hasSuffix("More") == true)
        // Nothing is lost between pieces: they cut only at the space after a sentence.
        #expect(after.map(\.text).joined(separator: " ") == text + "More")
    }
    @Test func slidingTheFrontOfAStreamingParagraphKeepsTheMiddlePieces() {
        let message = (1...200).map { "Next step \($0): wire the safe kill-all filters." }.joined(separator: " ")
        let window = { (start: Int) in
            Markdown.pieces(String(message.utf8.dropFirst(start))!, at: start, size: 400)
        }
        let before = window(1_000), after = window(1_090)
        let kept = Set(before.dropFirst().map(\.offset))
        // Every piece but the first starts where it did, with the same text.
        for piece in after.dropFirst() {
            #expect(kept.contains(piece.offset))
            #expect(before.first { $0.offset == piece.offset }?.text == piece.text)
        }
        #expect(after.count >= before.count - 1)
    }
    @Test func aShortParagraphStaysWhole() {
        #expect(Markdown.pieces("One sentence. Two sentences.").map(\.text) == ["One sentence. Two sentences."])
        #expect(Markdown.pieces("").map(\.text) == [""])
    }
    @Test func plainProseIsStyledExactlyAsTheMarkdownParserStylesIt() {
        let parsed = { (text: String) in
            let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
            return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        }
        let prose = [
            " Next step 12: wire the safe kill-all filters. Next step 13: done!",
            "  Leading and trailing spaces, a\ttab and 3.5 % (about) \"quoted\" — ünïcödé 🚀  ",
            "Ends with a colon: 1/2 of 10, x+y=z, #hash, a|b, $5 and {braces}?",
            "", " ", "www", "w.w.w. and a.b.c",
        ]
        for text in prose {
            #expect(Markdown.isPlain(text), "\(text)")
            #expect(Markdown.inline(text) == parsed(text), "\(text)")
        }
        // Anything the parser could read goes through it.
        let marked = ["a **b**", "a `b`", "a _b_", "a ~~b~~", "[a](b)", "<b>", "a &amp; b", "a\\*b", "see https://ace.dev", "see www.ace.dev", "mail me@ace.dev", "line\nbreak"]
        for text in marked {
            #expect(!Markdown.isPlain(text), "\(text)")
            #expect(Markdown.inline(text) == parsed(text), "\(text)")
        }
    }
}
