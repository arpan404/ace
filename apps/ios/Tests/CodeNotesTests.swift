import Foundation
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
        notes.renamed(in: nil, thread: "t", from: "src/total.ts", to: "src/sum.ts")
        #expect(notes["t"].map(\.path) == ["src/sum.ts", "src/view.tsx"])
        // A folder moved takes the notes on every file in it.
        notes.renamed(in: nil, thread: "t", from: "src/", to: "lib")
        #expect(notes["t"].map(\.path) == ["lib/sum.ts", "lib/view.tsx"])
    }

    @Test func aRenameInOneCheckoutLeavesAnotherCheckoutsNotesOnTheSamePath() {
        var notes = CodeNotes()
        let cart = ["let total = 0"]
        notes.add("a", path: "src/cart.ts", span: span((0, 4), (0, 9)), lines: cart, comment: "A", id: "a1", checkout: "mac\u{0}/w/one")
        notes.add("b", path: "src/cart.ts", span: span((0, 4), (0, 9)), lines: cart, comment: "B", id: "b1", checkout: "mac\u{0}/w/two")
        notes.renamed(in: "mac\u{0}/w/one", thread: "a", from: "src/cart.ts", to: "src/basket.ts")
        #expect(notes["a"].map(\.path) == ["src/basket.ts"])
        #expect(notes["b"].map(\.path) == ["src/cart.ts"])
        // A thread sharing the checkout sees the same files, so its notes follow too.
        notes.add("c", path: "src/basket.ts", span: span((0, 4), (0, 9)), lines: cart, comment: "C", id: "c1", checkout: "mac\u{0}/w/one")
        notes.renamed(in: "mac\u{0}/w/one", thread: "a", from: "src/basket.ts", to: "src/bag.ts")
        #expect(notes["c"].map(\.path) == ["src/bag.ts"])
        #expect(notes["b"].map(\.path) == ["src/cart.ts"])
    }

    @Test func aNoteWrittenWhileTheFileReloadedLandsOnItsCodeOrComesOutdated() {
        var notes = CodeNotes()
        // The sheet opened on line 2; an agent then added a line above it.
        let moved = AnnotationAnchor.lines("import x;\n" + file.joined(separator: "\n"))
        notes.add("t", path: "src/total.ts", span: span((1, 2), (1, 14)), lines: file, now: moved, comment: "Sum", id: "a")
        #expect(notes["t"].first?.span == span((2, 2), (2, 14)))
        #expect(notes["t"].first?.outdated == false)
        // Or rewrote it so its code is gone: the note joins, outdated, with the code it was on.
        let gone = AnnotationAnchor.lines("export const total = () => 0;")
        notes.add("t", path: "src/total.ts", span: span((1, 2), (1, 14)), lines: file, now: gone, comment: "Sum", id: "b")
        #expect(notes["t"].last?.outdated == true)
        #expect(notes["t"].last?.excerpt == "let sum = 0;")
    }

    @Test func typingWhereAnOutdatedNoteWasKeepsTheCodeItWasOn() {
        var notes = two()
        let gone = AnnotationAnchor.lines("export const total = () => 0;")
        notes.reloaded("t", path: "src/total.ts", before: file, after: gone)
        let point = notes["t"].first?.span.start ?? TextPlace(line: 0, column: 0)
        let typed = TextReplacement.replacing(from: point, to: point, with: "abc")
        notes.edited("t", path: "src/total.ts", through: [typed], lines: AnnotationAnchor.lines("abcexport const total = () => 0;"))
        #expect(notes["t"].first?.outdated == true)
        #expect(notes["t"].first?.excerpt == "let sum = 0;\n  return sum")
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

/// The bridge's word that a message took notes, and how the chips name them.
@MainActor @Suite struct CodeNoteChipsTests {
    @Test func theBridgeSaysWhichNotesASentMessageTook() throws {
        let json = #"{"type":"thread.codeSent","threadId":"t","epoch":1,"ids":["a","b"]}"#
        let patch = try JSONDecoder().decode(BridgePatch.self, from: Data(json.utf8))
        guard case .screen(let id, _, .codeSent(let ids)) = patch else { Issue.record("Expected the notes that went"); return }
        #expect(id == "t")
        #expect(ids == ["a", "b"])
    }

    @Test func notesASendTookLeaveTheirThreadEvenAfterThePersonLeftIt() throws {
        let model = ClientModel(now: { 0 })
        model.open("a")
        let epoch = model.thread?.epoch ?? 0
        model.codeNotes.add("a", path: "a.ts", span: TextSpan(start: TextPlace(line: 0, column: 0), end: TextPlace(line: 0, column: 1)),
                            lines: ["x"], comment: "", id: "n1")
        model.codeNotes.add("a", path: "a.ts", span: TextSpan(start: TextPlace(line: 0, column: 0), end: TextPlace(line: 0, column: 1)),
                            lines: ["x"], comment: "", id: "n2")
        // The person opens another thread while the message is being saved.
        model.open("b")
        let ack: [[String: Any]] = [["type": "thread.codeSent", "threadId": "a", "epoch": epoch, "ids": ["n1"]]]
        model.receive(try JSONSerialization.data(withJSONObject: ack))
        #expect(model.codeNotes["a"].map(\.id) == ["n2"])
    }

    @Test func theChipNamesOneNoteByItsPlaceAndSeveralByCount() {
        let one = CodeNote(id: "a", path: "src/cart/total.ts", span: TextSpan(start: TextPlace(line: 1, column: 2), end: TextPlace(line: 2, column: 12)),
                           excerpt: "x", cut: false, comment: "")
        let line = CodeNote(id: "b", path: "view.tsx", span: TextSpan(start: TextPlace(line: 4, column: 0), end: TextPlace(line: 5, column: 0)),
                            excerpt: "y", cut: false, comment: "")
        #expect(CodeNoteChips.label([one]) == "Note on total.ts:2–3")
        #expect(CodeNoteChips.label([line]) == "Note on view.tsx:5")
        #expect(CodeNoteChips.label([one, line]) == "2 code notes")
        #expect(FileNotesChip.lines(one) == "lines 2–3")
    }
}
