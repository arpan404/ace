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

    private func noted(_ root: URL, scope: String = "alice", _ comments: [String]) -> (ClientModel, [String]) {
        let model = ClientModel(now: { 0 })
        model.restoreCodeNotes(keptScope: scope, in: root)
        let ids = comments.enumerated().compactMap { index, comment in
            try? model.addDiffNote("t", path: "a.ts", first: index + 1, texts: ["line \(index)"], comment: comment).get()
        }
        return (model, ids)
    }
    private func kept(_ root: URL, scope: String = "alice") -> [String] {
        let model = ClientModel(now: { 0 })
        model.restoreCodeNotes(keptScope: scope, in: root)
        return model.codeNotes["t"].map(\.comment)
    }

    @Test func aNoteAMessageIsCarryingIsOffTheDiskSoAKillMidSendNeverSendsItTwice() async {
        let root = directory()
        let (model, ids) = noted(root, ["Goes"])
        var onDiskMidSend = ["not read"]
        let saved = await model.sendingCodeNotes("t") {
            // The machine may have saved the message when the app is killed here.
            onDiskMidSend = kept(root)
            return .saved(carried: ids)
        }
        #expect(saved)
        #expect(onDiskMidSend.isEmpty)
        #expect(model.codeNotes["t"].isEmpty)
        #expect(kept(root).isEmpty)
    }

    @Test func aMessageTheMachineRefusedGivesItsNotesBackAheadOfOnesMadeMeanwhile() async {
        let root = directory()
        let (model, _) = noted(root, ["First"])
        let saved = await model.sendingCodeNotes("t") {
            _ = model.addDiffNote("t", path: "a.ts", first: 2, texts: ["y"], comment: "Meanwhile")
            return .refused
        }
        #expect(!saved)
        #expect(model.codeNotes["t"].map(\.comment) == ["First", "Meanwhile"])
        #expect(kept(root) == ["First", "Meanwhile"])
    }

    @Test func aSavedMessageSettlesOnlyTheNotesItCarriedAndAGoalCarriesNone() async {
        let root = directory()
        let (model, ids) = noted(root, ["Carried", "Left"])
        // A message that carried the first only: the second stays for the next.
        #expect(await model.sendingCodeNotes("t") { .saved(carried: [ids[0]]) })
        #expect(model.codeNotes["t"].map(\.comment) == ["Left"])
        // A /goal or a question's answer is saved without notes: they all stay.
        #expect(await model.sendingCodeNotes("t") { .saved(carried: []) })
        #expect(model.codeNotes["t"].map(\.comment) == ["Left"])
        #expect(kept(root) == ["Left"])
    }

    @Test func aSendWhoseAnswerWasLostKeepsItsNotesOffSoTheyNeverGoTwice() async {
        let root = directory()
        let (model, _) = noted(root, ["Maybe sent"])
        // The runtime was replaced while the machine may already have saved the message.
        #expect(!(await model.sendingCodeNotes("t") { .unknown }))
        #expect(model.codeNotes["t"].isEmpty)
        #expect(kept(root).isEmpty)
    }

    @Test func notesThatCantLeaveTheDiskDontGoAndTheMessageIsHeldBack() async throws {
        let root = directory()
        let (model, _) = noted(root, ["Stays"])
        model.codeNotesKept = CodeNotesKept(url: root.appendingPathComponent("notes.json"), delay: .seconds(60))
        try FileManager.default.removeItem(at: root)
        try Data().write(to: root)
        var dispatched = false
        let saved = await model.sendingCodeNotes("t") { dispatched = true; return .saved(carried: []) }
        #expect(!saved)
        #expect(!dispatched)
        #expect(model.codeNotes["t"].map(\.comment) == ["Stays"])
        #expect(model.error == CodeNoteRefusal.notSent.message)
    }

    @Test func aRefusedSendAfterSwitchingAccountsGivesTheNotesBackToTheirOwnAccount() async {
        let root = directory()
        let (model, _) = noted(root, scope: "alice", ["Alice's"])
        let saved = await model.sendingCodeNotes("t") {
            // Bob signs in on the same machine before the old send is answered.
            model.restoreCodeNotes(keptScope: "bob", in: root)
            _ = model.addDiffNote("t", path: "a.ts", first: 1, texts: ["b"], comment: "Bob's")
            return .refused
        }
        #expect(!saved)
        #expect(model.codeNotes["t"].map(\.comment) == ["Bob's"])
        #expect(kept(root, scope: "bob") == ["Bob's"])
        #expect(kept(root, scope: "alice") == ["Alice's"])
    }

    @Test func notesInFlightCountTowardTheLimitSoAFailedSendLosesNone() async {
        let root = directory()
        let (model, _) = noted(root, (0..<CodeNotes.limit).map { "n\($0)" })
        var meanwhile: Result<String, CodeNoteRefusal>?
        _ = await model.sendingCodeNotes("t") {
            meanwhile = model.addDiffNote("t", path: "a.ts", first: 1, texts: ["x"], comment: "21st")
            return .refused
        }
        #expect(meanwhile == .failure(.full))
        #expect(model.codeNotes["t"].count == CodeNotes.limit)
    }

    @Test func aMessageTooLongToSendIsRefusedBeforeAnythingGoesAndKeepsItsNotes() async {
        let root = directory()
        let (model, _) = noted(root, ["Stays"])
        model.open("t")
        let saved = await model.sendMessage(String(repeating: "a", count: ClientModel.messageLimit + 1), alternate: false)
        #expect(!saved)
        #expect(model.error == ClientModel.tooLongToSend)
        #expect(model.codeNotes["t"].map(\.comment) == ["Stays"])
        #expect(kept(root) == ["Stays"])
    }

    @Test func notesThatCantLeaveTheDiskStopTheSendBeforeTheReviewCommentsGo() async throws {
        let root = directory()
        let (model, _) = noted(root, ["Stays"])
        model.open("t")
        // Review comments wait on the chip; were they sent first, the send would stop on them.
        model.sheets.chip = CommentChipRow(count: 1, label: "1 comment", path: "a.ts")
        model.codeNotesKept = CodeNotesKept(url: root.appendingPathComponent("notes.json"), delay: .seconds(60))
        try FileManager.default.removeItem(at: root)
        try Data().write(to: root)
        #expect(!(await model.sendMessage("Fix these", alternate: false)))
        #expect(model.error == CodeNoteRefusal.notSent.message)
        #expect(model.codeNotes["t"].map(\.comment) == ["Stays"])
    }

    @Test func aStoreLetGoWithAWriteStillPendingWritesItOnceItCan() async throws {
        let root = directory()
        let url = root.appendingPathComponent("notes.json")
        var notes = CodeNotes()
        notes.add("t", path: "a.ts", first: 1, texts: ["x"], comment: "Rolled back", id: "n")
        var store: CodeNotesKept? = CodeNotesKept(url: url, delay: .milliseconds(10))
        try FileManager.default.createDirectory(at: root.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: root)
        #expect(store?.save(notes) == false)
        // A switch of account let the store go; its rollback must still reach the disk.
        store = nil
        try FileManager.default.removeItem(at: root)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        for _ in 0..<300 where !FileManager.default.fileExists(atPath: url.path) { try await Task.sleep(for: .milliseconds(10)) }
        #expect(CodeNotesKept(url: url).load()["t"].map(\.comment) == ["Rolled back"])
    }

    @Test func theMachinesAnswerNamesTheNotesAMessageCarried() throws {
        let json = #"{"type":"admission","id":"7","ok":true,"message":"","notes":["a","b"]}"#
        guard case .admission(let id, let ok, _, let notes) = try JSONDecoder().decode(BridgePatch.self, from: Data(json.utf8)) else {
            Issue.record("Expected an admission"); return
        }
        #expect(id == "7" && ok)
        #expect(notes == ["a", "b"])
        let plain = #"{"type":"receipt","id":"8","ok":true,"message":""}"#
        guard case .receipt(_, _, _, let none) = try JSONDecoder().decode(BridgePatch.self, from: Data(plain.utf8)) else {
            Issue.record("Expected a receipt"); return
        }
        #expect(none.isEmpty)
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

private extension Result {
    var isSuccess: Bool { if case .success = self { true } else { false } }
}
