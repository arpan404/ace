import Testing
@testable import Ace

/// Keeping a note on its code in the phone's editor: through typing, through a file the agent
/// rewrote, and at open. The rules are the web editor's (`annotate-anchor.ts`).
@Suite struct AnnotationAnchorTests {
    private func at(_ line: Int, _ column: Int) -> TextPlace { TextPlace(line: line, column: column) }
    private func span(_ a: (Int, Int), _ b: (Int, Int)) -> TextSpan { TextSpan(start: at(a.0, a.1), end: at(b.0, b.1)) }
    private func kept(_ span: TextSpan) -> Anchored { Anchored(span: span, outdated: false) }
    private func edit(_ start: (Int, Int), _ end: (Int, Int), _ postEnd: (Int, Int)) -> [TextReplacement] {
        [TextReplacement(start: at(start.0, start.1), end: at(end.0, end.1), postEnd: at(postEnd.0, postEnd.1))]
    }
    private func lines(_ text: String) -> [String] { AnnotationAnchor.lines(text) }

    @Test func aNoteFollowsItsLinesAfterAnEditAboveIt() {
        let note = span((4, 2), (6, 8))
        // Two lines typed on line 1.
        #expect(AnnotationAnchor.map(note, through: edit((1, 0), (1, 0), (3, 0))) == kept(span((6, 2), (8, 8))))
        // Typing on its first line, before it, moves its start along the line only.
        #expect(AnnotationAnchor.map(note, through: edit((4, 0), (4, 0), (4, 3))) == kept(span((4, 5), (6, 8))))
        // A line deleted above it.
        #expect(AnnotationAnchor.map(note, through: edit((1, 0), (2, 0), (1, 0))) == kept(span((3, 2), (5, 8))))
        // Edits below leave it.
        #expect(AnnotationAnchor.map(note, through: edit((9, 0), (9, 4), (9, 0))) == kept(note))
    }

    @Test func textTypedOnANotesEdgesJoinsIt() {
        let note = span((2, 4), (2, 9))
        #expect(AnnotationAnchor.map(note, through: edit((2, 4), (2, 4), (2, 6))) == kept(span((2, 4), (2, 11))))
        #expect(AnnotationAnchor.map(note, through: edit((2, 9), (2, 9), (2, 12))) == kept(span((2, 4), (2, 12))))
    }

    @Test func aDeletionOverOneEdgeShrinksTheNoteToWhatIsLeftOfItsCode() {
        let note = span((2, 4), (2, 9))
        #expect(AnnotationAnchor.map(note, through: edit((2, 2), (2, 6), (2, 2))) == kept(span((2, 2), (2, 5))))
        #expect(AnnotationAnchor.map(note, through: edit((2, 7), (2, 12), (2, 7))) == kept(span((2, 4), (2, 7))))
    }

    @Test func codeDeletedFromOutsideItsEdgesLeavesAnOutdatedPoint() {
        let note = span((3, 0), (5, 0))
        #expect(AnnotationAnchor.map(note, through: edit((2, 0), (6, 0), (2, 0))) == Anchored(span: span((2, 0), (2, 0)), outdated: true))
        // Text put exactly in its place stays noted.
        #expect(!AnnotationAnchor.map(note, through: edit((3, 0), (5, 0), (3, 7))).outdated)
    }

    @Test func anEditIsMeasuredFromWhatItReplacedAndWhatItTyped() {
        // "ab\ncd" typed at line 2 column 3 over two characters.
        let typed = TextReplacement.replacing(from: at(2, 3), to: at(2, 5), with: "ab\ncd")
        #expect(typed == TextReplacement(start: at(2, 3), end: at(2, 5), postEnd: at(3, 2)))
        let letter = TextReplacement.replacing(from: at(0, 1), to: at(0, 1), with: "x")
        #expect(letter.postEnd == at(0, 2))
        #expect(AnnotationAnchor.touches(span((2, 4), (2, 6)), [typed]))
        #expect(!AnnotationAnchor.touches(span((4, 0), (4, 6)), [typed]))
    }

    @Test func aNotesTextIsReadByUTF16Columns() {
        let text = lines("let é = 1\nlet 👍 = 2\nend")
        #expect(AnnotationAnchor.text(of: span((0, 4), (1, 6)), in: text) == "é = 1\nlet 👍")
        #expect(AnnotationAnchor.text(of: span((2, 0), (2, 3)), in: text) == "end")
    }

    @Test func aRewriteBelowOrAboveANoteKeepsItOnTheSameCode() {
        let before = ["a", "b", "keep me", "c", "d"]
        let note = span((2, 0), (2, 7))
        let below = Array(before.prefix(4)) + ["new", "d"]
        #expect(AnnotationAnchor.reanchor(note, excerpt: "keep me", cut: false, before: before, after: below) == kept(note))
        let above = ["new", "lines"] + before
        #expect(AnnotationAnchor.reanchor(note, excerpt: "keep me", cut: false, before: before, after: above) == kept(span((4, 0), (4, 7))))
    }

    @Test func aRewriteAroundANoteFindsItsCodeOnceOrCallsItOutdated() {
        let before = lines("top\nfunction a() {\n  return 1;\n}\nbottom")
        let note = span((1, 0), (3, 1))
        let code = "function a() {\n  return 1;\n}"
        let moved = lines("TOP\nimport x;\n\nfunction a() {\n  return 1;\n}\nBOTTOM")
        #expect(AnnotationAnchor.reanchor(note, excerpt: code, cut: false, before: before, after: moved) == kept(span((3, 0), (5, 1))))
        // Changed code is not followed to look-alikes.
        let changed = lines("TOP\nfunction a() {\n  return 2;\n}\nBOTTOM")
        #expect(AnnotationAnchor.reanchor(note, excerpt: code, cut: false, before: before, after: changed)
                == Anchored(span: span((1, 0), (1, 0)), outdated: true))
        // Two copies: nothing says which, so neither.
        let twice = lines("X\n\(code)\n\(code)\nY")
        #expect(AnnotationAnchor.reanchor(note, excerpt: code, cut: false, before: before, after: twice).outdated)
    }

    @Test func atOpenAStoredNoteIsCheckedAgainstTheFilesText() {
        #expect(AnnotationAnchor.verify(span((1, 0), (1, 3)), excerpt: "two", cut: false, lines: lines("one\ntwo\nthree")) == kept(span((1, 0), (1, 3))))
        #expect(AnnotationAnchor.verify(span((1, 0), (1, 3)), excerpt: "two", cut: false, lines: lines("zero\none\ntwo\nthree")) == kept(span((2, 0), (2, 3))))
        #expect(AnnotationAnchor.verify(span((1, 0), (1, 3)), excerpt: "two", cut: false, lines: lines("one\nTWO"))
                == Anchored(span: span((1, 0), (1, 0)), outdated: true))
    }

    @Test func aLongRangeKeepsItsFirstLinesAndSaysItWasCut() {
        let long = String(repeating: "0123456789\n", count: 500)
        let excerpt = AnnotationAnchor.excerpt(long)
        #expect(excerpt.cut)
        #expect(excerpt.text.utf16.count <= AnnotationAnchor.excerptLimit)
        #expect(excerpt.text.hasSuffix("0123456789"))
        #expect(AnnotationAnchor.excerpt("short") == CodeExcerpt(text: "short", cut: false))
    }
}
