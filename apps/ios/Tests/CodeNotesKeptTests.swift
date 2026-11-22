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
        #expect((sent.first?["end"] as? [String: Int]) == ["line": 12, "column": 13])
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
        // Not on a shown line, and not found on any: its place can't be told from this diff, so
        // the agent is told so rather than sent line 40 as where the code is now.
        #expect(byId["unseen"]?.unverified == true)
        #expect(byId["unseen"]?.span == span((39, 0), (39, 5)))
        #expect(notes.wire("t").first { $0["id"] as? String == "unseen" }?["outdated"] as? Bool == true)
        #expect(byId["other"]?.outdated == false)
    }

    @Test func codeThatNowStandsTwiceInTheDiffIsOutdatedNotGuessed() {
        var notes = CodeNotes()
        notes.add("t", path: "a.ts", first: 3, texts: ["x += 1"], comment: "", id: "a")
        notes.shown("t", path: "a.ts", lines: [3: "y", 10: "x += 1", 11: "", 20: "x += 1"])
        #expect(notes["t"].first?.outdated == true)
    }

    @Test func aHunkMovedPastTheLinesTheDiffShowsIsFoundWhereItIsNow() {
        var notes = CodeNotes()
        notes.add("t", path: "a.ts", first: 40, texts: ["total(items)", "  .round()"], comment: "", id: "a")
        // A hundred lines went in above: line 40 isn't in the new diff, the hunk is at 140.
        notes.shown("t", path: "a.ts", lines: [1: "// new", 2: "// new", 139: "", 140: "total(items)", 141: "  .round()", 142: ""])
        #expect(notes["t"].first?.span == span((139, 0), (140, 10)))
        #expect(notes["t"].first?.outdated == false)
        #expect(notes["t"].first?.unverified == false)
    }

    @Test func anUnverifiedNoteIsConfirmedOnceTheEditorFindsItsCode() {
        var notes = CodeNotes()
        notes.add("t", path: "a.ts", first: 3, texts: ["call()"], comment: "", id: "a")
        notes.shown("t", path: "a.ts", lines: [10: "other()"])
        #expect(notes["t"].first?.unverified == true)
        notes.reloaded("t", path: "a.ts", before: nil, after: ["", "", "", "", "call()"])
        #expect(notes["t"].first?.unverified == false)
        #expect(notes["t"].first?.outdated == false)
        #expect(notes["t"].first?.span == span((4, 0), (4, 6)))
        #expect(notes.wire("t").first?["outdated"] == nil)
    }

    @Test func aNoteIsOnDiskOnceTheAppSaysItWasAddedAndComesBackOnRelaunch() {
        let root = directory()
        let model = ClientModel(now: { 0 })
        model.restoreCodeNotes(keptScope: "alice", in: root)
        let added = model.addDiffNote("t", path: "a.ts", first: 3, texts: ["bye"], comment: "Part")
        guard case .success(let id) = added else { Issue.record("Expected the note to be added"); return }
        // The app is killed straight after: no flush, no wait.
        let relaunched = ClientModel(now: { 0 })
        relaunched.restoreCodeNotes(keptScope: "alice", in: root)
        #expect(relaunched.codeNotes["t"].map(\.id) == [id])
        #expect(relaunched.codeNotes["t"].first?.comment == "Part")
        // A message that took it, then a kill: it doesn't come back to be sent twice.
        relaunched.codeNotesSent("t", ids: [id])
        let again = ClientModel(now: { 0 })
        again.restoreCodeNotes(keptScope: "alice", in: root)
        #expect(again.codeNotes["t"].isEmpty)
    }

    @Test func anotherAccountOnTheSameMachineAndPhoneNeverSeesTheNotes() {
        let root = directory()
        let model = ClientModel(now: { 0 })
        model.restoreCodeNotes(keptScope: KeptScope.of(principal: "account:a", hostId: "mac"), in: root)
        _ = model.addDiffNote("t", path: "a.ts", first: 1, texts: ["x"], comment: "A's")
        model.restoreCodeNotes(keptScope: KeptScope.of(principal: "account:b", hostId: "mac"), in: root)
        #expect(model.codeNotes["t"].isEmpty)
        // Signed out: none shown, and none kept.
        model.restoreCodeNotes(keptScope: nil, in: root)
        #expect(model.codeNotes["t"].isEmpty)
        model.restoreCodeNotes(keptScope: KeptScope.of(principal: "account:a", hostId: "mac"), in: root)
        #expect(model.codeNotes["t"].map(\.comment) == ["A's"])
    }

    @Test func aNoteThatCantBeWrittenIsRefusedAndOtherChangesAreWrittenOnceTheyCanBe() async throws {
        let root = directory()
        let kept = root.appendingPathComponent("notes.json")
        let model = ClientModel(now: { 0 })
        model.codeNotesKept = CodeNotesKept(url: kept, delay: .milliseconds(10))
        guard case .success(let first) = model.addDiffNote("t", path: "a.ts", first: 1, texts: ["x"], comment: "First") else {
            Issue.record("Expected the first note to be added"); return
        }
        // The phone can't write there any more: a file stands where the notes' folder was.
        try FileManager.default.removeItem(at: root)
        try Data().write(to: root)
        // A new note isn't confirmed when it can't be kept, so the person still has their words.
        #expect(model.addDiffNote("t", path: "a.ts", first: 2, texts: ["y"], comment: "Second") == .failure(.notSaved))
        #expect(model.codeNotes["t"].map(\.id) == [first])
        // New words aren't confirmed either: the sheet keeps them, and the note its old ones.
        #expect(model.commentCodeNote("t", id: first, "First, edited") == .notSaved)
        #expect(model.codeNotes["t"].map(\.comment) == ["First"])
        // A removal that can't be written yet waits, and is written once the phone can.
        model.removeCodeNote("t", id: first)
        try FileManager.default.removeItem(at: root)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        for _ in 0..<300 where !FileManager.default.fileExists(atPath: kept.path) { try await Task.sleep(for: .milliseconds(10)) }
        #expect(FileManager.default.fileExists(atPath: kept.path))
        #expect(CodeNotesKept(url: kept).load()["t"].isEmpty)
    }

    @Test func aNoteAMessageIsCarryingIsOffTheDiskSoAKillMidSendNeverSendsItTwice() async {
        let root = directory()
        let model = ClientModel(now: { 0 })
        model.restoreCodeNotes(keptScope: "alice", in: root)
        _ = model.addDiffNote("t", path: "a.ts", first: 1, texts: ["x"], comment: "Goes")
        var onDiskMidSend: [CodeNote] = [placeholder()]
        let saved = await model.sendingCodeNotes("t") {
            // The machine may have admitted the message when the app is killed here.
            let relaunched = ClientModel(now: { 0 })
            relaunched.restoreCodeNotes(keptScope: "alice", in: root)
            onDiskMidSend = relaunched.codeNotes["t"]
            return true
        }
        #expect(saved)
        #expect(onDiskMidSend.isEmpty)
        #expect(model.codeNotes["t"].isEmpty)
    }

    @Test func aMessageThatWasntSavedGivesItsNotesBackAheadOfOnesMadeMeanwhile() async {
        let root = directory()
        let model = ClientModel(now: { 0 })
        model.restoreCodeNotes(keptScope: "alice", in: root)
        _ = model.addDiffNote("t", path: "a.ts", first: 1, texts: ["x"], comment: "First")
        let saved = await model.sendingCodeNotes("t") {
            _ = model.addDiffNote("t", path: "a.ts", first: 2, texts: ["y"], comment: "Meanwhile")
            return false
        }
        #expect(!saved)
        #expect(model.codeNotes["t"].map(\.comment) == ["First", "Meanwhile"])
        let relaunched = ClientModel(now: { 0 })
        relaunched.restoreCodeNotes(keptScope: "alice", in: root)
        #expect(relaunched.codeNotes["t"].map(\.comment) == ["First", "Meanwhile"])
        // The machine's word that the message took the first after all still drops it.
        relaunched.codeNotesSent("t", ids: [relaunched.codeNotes["t"][0].id])
        #expect(relaunched.codeNotes["t"].map(\.comment) == ["Meanwhile"])
    }

    @Test func aRereadThatShowsNoNewLinesLeavesTheNotesUnverified() {
        var notes = CodeNotes()
        notes.add("t", path: "a.ts", first: 3, texts: ["call()"], comment: "", id: "a")
        // Only deletions are left in the diff: no line of the new side to check against.
        notes.shown("t", path: "a.ts", lines: [:])
        #expect(notes["t"].first?.unverified == true)
        #expect(notes["t"].first?.outdated == false)
    }

    @Test func aCommentLongerThanTheAgentTakesIsRefusedBeforeItIsConfirmed() {
        let model = ClientModel(now: { 0 })
        // 2,000 emoji are 4,000 UTF-16 units: the most a note's words can be.
        #expect(model.addDiffNote("t", path: "a.ts", first: 1, texts: ["x"], comment: String(repeating: "😀", count: 2000)).isSuccess)
        let long = String(repeating: "a", count: CodeNotes.commentLimit + 1)
        #expect(model.addDiffNote("t", path: "a.ts", first: 1, texts: ["x"], comment: long) == .failure(.tooLong))
        #expect(CodeNoteRefusal.tooLong.message.contains(CodeNotes.commentLimit.formatted()))
        #expect(model.codeNotes["t"].count == 1)
        // New words that are too long are refused too, and the note keeps its own.
        let id = model.codeNotes["t"][0].id
        #expect(model.commentCodeNote("t", id: id, long) == .tooLong)
        #expect(model.codeNotes["t"][0].comment.utf16.count == 4000)
    }

    @Test func aBurstOfEditsIsWrittenOnceItSettles() async throws {
        let url = directory().appendingPathComponent("notes.json")
        let kept = CodeNotesKept(url: url, delay: .milliseconds(20))
        var notes = CodeNotes()
        notes.add("t", path: "a.ts", first: 1, texts: ["a"], comment: "", id: "1")
        kept.changed(notes)
        #expect(!FileManager.default.fileExists(atPath: url.path))
        notes.comment("t", id: "1", "later")
        kept.changed(notes)
        for _ in 0..<100 where !FileManager.default.fileExists(atPath: url.path) { try await Task.sleep(for: .milliseconds(10)) }
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

/// A placeholder note, so a check that never ran reads as a failure.
private func placeholder() -> CodeNote {
    CodeNote(id: "placeholder", path: "", span: TextSpan(start: TextPlace(line: 0, column: 0), end: TextPlace(line: 0, column: 0)),
             excerpt: "", cut: false, comment: "")
}

private extension Result {
    var isSuccess: Bool { if case .success = self { true } else { false } }
}
