import Testing
@testable import Ace

/// The editor's code notes for a thread's next message: numbered in the order they were made,
/// carried through typing and rewrites, following a renamed file, and dropped once a message
/// took them.
@Suite struct CodeNotesTests {
    private let file = AnnotationAnchor.lines("export function total(items) {\n  let sum = 0;\n  return sum;\n}")
    private func span(_ a: (Int, Int), _ b: (Int, Int)) -> TextSpan {
        TextSpan(start: TextPlace(line: a.0, column: a.1), end: TextPlace(line: b.0, column: b.1))
    }
    private func two() -> CodeNotes {
        var notes = CodeNotes()
        notes.add("t", path: "src/total.ts", span: span((1, 2), (2, 12)), lines: file, comment: "Sum the prices", id: "a")
        notes.add("t", path: "src/view.tsx", span: span((0, 0), (0, 6)), lines: ["return <ul />;"], comment: "Render", id: "b")
        return notes
    }

    @Test func twoNotesGoToTheThreadNumberedWithTheirCode() {
        let sent = two().wire("t")
        #expect(sent.map { $0["number"] as? Int } == [1, 2])
        #expect(sent.map { $0["path"] as? String } == ["src/total.ts", "src/view.tsx"])
        #expect(sent.first?["excerpt"] as? String == "let sum = 0;\n  return sum")
        #expect(sent.first?["comment"] as? String == "Sum the prices")
        #expect((sent.first?["start"] as? [String: Int]) == ["line": 1, "column": 2])
        #expect(CodeNotes().wire("t").isEmpty)
    }

    @Test func aNoteFollowsItsLinesAfterAnEditAboveIt() {
        var notes = two()
        // A line typed above the first note's code, in its file only.
        let typed = TextReplacement.replacing(from: TextPlace(line: 0, column: 30), to: TextPlace(line: 0, column: 30), with: "\n  // total")
        let after = AnnotationAnchor.lines("export function total(items) {\n  // total\n  let sum = 0;\n  return sum;\n}")
        notes.edited("t", path: "src/total.ts", through: [typed], lines: after)
        #expect(notes["t"].first?.span == span((2, 2), (3, 12)))
        #expect(notes["t"].first?.outdated == false)
        #expect(notes["t"].last?.span == span((0, 0), (0, 6)))
    }

    @Test func anEditInsideANoteKeepsItsTextUpToDate() {
        var notes = two()
        let typed = TextReplacement.replacing(from: TextPlace(line: 1, column: 13), to: TextPlace(line: 1, column: 14), with: "")
        let after = AnnotationAnchor.lines("export function total(items) {\n  let sum = 0\n  return sum;\n}")
        notes.edited("t", path: "src/total.ts", through: [typed], lines: after)
        #expect(notes["t"].first?.excerpt == "let sum = 0\n  return sum")
    }

    @Test func aFileTheAgentRewroteKeepsItsNotesOnTheirCodeOrMarksThemOutdated() {
        var notes = two()
        let moved = AnnotationAnchor.lines("import x;\n\nexport function total(items) {\n  let sum = 0;\n  return sum;\n}")
        notes.reloaded("t", path: "src/total.ts", before: file, after: moved)
        #expect(notes["t"].first?.span == span((3, 2), (4, 12)))
        let gone = AnnotationAnchor.lines("export const total = () => 0;")
        notes.reloaded("t", path: "src/total.ts", before: moved, after: gone)
        #expect(notes["t"].first?.outdated == true)
        #expect(notes.wire("t").first?["outdated"] as? Bool == true)
    }

    @Test func aNoteFollowsItsFileToANewPath() {
        var notes = two()
        notes.renamed(from: "src/total.ts", to: "src/sum.ts")
        #expect(notes["t"].map(\.path) == ["src/sum.ts", "src/view.tsx"])
    }

    @Test func removingANoteClosesRanksAndASentMessageDropsOnlyWhatItTook() {
        var notes = two()
        notes.add("t", path: "c.ts", span: span((0, 0), (0, 1)), lines: ["x"], comment: "Third", id: "c")
        notes.remove("t", id: "a")
        #expect(notes.wire("t").map { $0["number"] as? Int } == [1, 2])
        notes.sent("t", ids: ["b"])
        #expect(notes["t"].map(\.id) == ["c"])
        // Another thread's notes are its own.
        #expect(notes["other"].isEmpty)
    }

    @Test func editingANotesCommentKeepsItsPlaceAndPastTheLimitNoneJoin() {
        var notes = two()
        notes.comment("t", id: "a", "Use reduce")
        #expect(notes["t"].first?.comment == "Use reduce")
        for index in 0..<CodeNotes.limit {
            notes.add("t", path: "x.ts", span: span((0, 0), (0, 1)), lines: ["x"], comment: "", id: "n\(index)")
        }
        #expect(notes["t"].count == CodeNotes.limit)
        #expect(notes.full("t"))
    }
}
