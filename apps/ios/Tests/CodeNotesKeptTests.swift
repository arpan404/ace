import Foundation
import Testing
@testable import Ace

/// Code notes made from a diff's lines, checked again when the diff is read again, and kept on the
/// phone so a relaunch gives back what waits on each thread's next message.
@MainActor @Suite struct CodeNotesKeptTests {
    private func span(_ a: (Int, Int), _ b: (Int, Int)) -> TextSpan {
        TextSpan(start: TextPlace(line: a.0, column: a.1), end: TextPlace(line: b.0, column: b.1))
    }
    private func directory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }

    @Test func aNoteOnADiffsLinesTakesThoseWholeLinesForTheAgent() {
        var notes = CodeNotes()
        notes.add("t", path: "src/cart.ts", first: 12, texts: ["  let sum = 0;", "  return sum;"], comment: "Use reduce", id: "a")
        let sent = notes.wire("t")
        #expect(sent.first?["excerpt"] as? String == "  let sum = 0;\n  return sum;")
        #expect((sent.first?["start"] as? [String: Int]) == ["line": 11, "column": 0])
        #expect((sent.first?["end"] as? [String: Int]) == ["line": 12, "column": 14])
        #expect(notes["t"].first?.lines == 12...13)
        // Blank lines hold no code to comment on.
        notes.add("t", path: "src/cart.ts", first: 3, texts: ["  ", ""], comment: "x", id: "b")
        #expect(notes["t"].map(\.id) == ["a"])
    }

    @Test func aDiffReadAgainKeepsMovesOrMarksOutdatedTheNotesWhoseLinesItShows() {
        var notes = CodeNotes()
        notes.add("t", path: "a.ts", first: 2, texts: ["let sum = 0;"], comment: "kept", id: "kept")
        notes.add("t", path: "a.ts", first: 5, texts: ["return sum;"], comment: "moved", id: "moved")
        notes.add("t", path: "a.ts", first: 8, texts: ["total()"], comment: "gone", id: "gone")
        notes.add("t", path: "a.ts", first: 40, texts: ["far()"], comment: "unseen", id: "unseen")
        notes.add("t", path: "b.ts", first: 2, texts: ["let sum = 0;"], comment: "other file", id: "other")
        // A push added a line above `return sum;` and rewrote `total()`; line 40 isn't in the diff.
        let shown = [1: "import x;", 2: "let sum = 0;", 3: "", 4: "// sum", 5: "", 6: "return sum;", 7: "", 8: "sum()"]
        notes.shown("t", path: "a.ts", lines: shown)
        let byId = Dictionary(uniqueKeysWithValues: notes["t"].map { ($0.id, $0) })
        #expect(byId["kept"]?.outdated == false)
        #expect(byId["kept"]?.span == span((1, 0), (1, 12)))
        #expect(byId["moved"]?.outdated == false)
        #expect(byId["moved"]?.span == span((5, 0), (5, 11)))
        #expect(byId["gone"]?.outdated == true)
        #expect(byId["gone"]?.excerpt == "total()")
        #expect(byId["unseen"]?.outdated == false)
        #expect(byId["unseen"]?.span == span((39, 0), (39, 5)))
        #expect(byId["other"]?.outdated == false)
    }

    @Test func codeThatNowStandsTwiceInTheDiffIsOutdatedNotGuessed() {
        var notes = CodeNotes()
        notes.add("t", path: "a.ts", first: 3, texts: ["x += 1"], comment: "", id: "a")
        notes.shown("t", path: "a.ts", lines: [3: "y", 10: "x += 1", 11: "", 20: "x += 1"])
        #expect(notes["t"].first?.outdated == true)
    }

    @Test func notesComeBackForTheSameMachineAfterARelaunchAndNotForAnother() {
        let root = directory()
        let model = ClientModel(now: { 0 })
        model.restoreCodeNotes(hostId: "mac", deviceId: "phone", in: root)
        model.codeNotes.add("t", path: "a.ts", span: span((0, 0), (0, 5)), lines: ["hello"], comment: "Greet", id: "n1", checkout: "mac\u{0}/w")
        model.codeNotes.add("t", path: "a.ts", first: 3, texts: ["bye"], comment: "Part", id: "n2")
        model.codeNotes.reloaded("t", path: "a.ts", before: nil, after: ["hi", "", "bye"])
        model.codeNotesKept?.flush()

        let relaunched = ClientModel(now: { 0 })
        relaunched.restoreCodeNotes(hostId: "mac", deviceId: "phone", in: root)
        #expect(relaunched.codeNotes == model.codeNotes)
        #expect(relaunched.codeNotes["t"].map(\.outdated) == [true, false])
        #expect(relaunched.codeNotes["t"].first?.checkout == "mac\u{0}/w")
        #expect(relaunched.codeNotes.number("t", id: "n2") == 2)

        relaunched.restoreCodeNotes(hostId: "other", deviceId: "phone", in: root)
        #expect(relaunched.codeNotes["t"].isEmpty)
        // A message that took the notes leaves nothing to come back.
        model.codeNotes.sent("t", ids: ["n1", "n2"])
        model.codeNotesKept?.flush()
        let again = ClientModel(now: { 0 })
        again.restoreCodeNotes(hostId: "mac", deviceId: "phone", in: root)
        #expect(again.codeNotes["t"].isEmpty)
    }

    @Test func aBurstOfChangesIsWrittenOnceItSettles() async throws {
        let url = directory().appendingPathComponent("notes.json")
        let kept = CodeNotesKept(url: url, delay: .milliseconds(20))
        var notes = CodeNotes()
        notes.add("t", path: "a.ts", first: 1, texts: ["a"], comment: "", id: "1")
        kept.changed(notes)
        #expect(!FileManager.default.fileExists(atPath: url.path))
        notes.comment("t", id: "1", "later")
        kept.changed(notes)
        try await Task.sleep(for: .milliseconds(200))
        #expect(CodeNotesKept(url: url).load()["t"].first?.comment == "later")
    }

    @Test func aNoteOnAFiftyFirstThreadLetsTheLeastRecentlyNotedThreadGo() {
        var notes = CodeNotes()
        for index in 0..<CodeNotes.threadLimit { notes.add("t\(index)", path: "a.ts", first: 1, texts: ["a"], comment: "", id: "n\(index)") }
        // Noting the first thread again makes it the most recent.
        notes.add("t0", path: "a.ts", first: 2, texts: ["b"], comment: "", id: "again")
        notes.add("new", path: "a.ts", first: 1, texts: ["a"], comment: "", id: "new")
        #expect(notes["t1"].isEmpty)
        #expect(notes["t0"].count == 2)
        #expect(notes["new"].count == 1)
    }
}
