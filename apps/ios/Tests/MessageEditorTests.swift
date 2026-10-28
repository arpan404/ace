import Foundation
import SQLite3
import Testing
@testable import Ace

/// The edit sheet's model: it starts from the message's full words, saves them fenced to the
/// revision they were read at, and a refused save keeps the sheet's words and says why.
@Suite @MainActor struct MessageEditorTests {
    private func answer(_ text: String, revision: Int? = 4) -> WordsRequests.Answer {
        WordsRequests.Answer(text: text, message: "", revision: revision)
    }

    @Test func theSheetStartsFromTheFullWordsNotThePreview() async {
        let long = String(repeating: "keep every message in order. ", count: 400) + "END"
        let editor = MessageEditor(attachments: 1, read: { answer(long) }, write: { _, _ in nil })
        await editor.load()
        #expect(editor.text == long)
        #expect(editor.canSave)
    }

    @Test func aSavedEditWritesTheWordsAtTheirRevisionAndClosesTheSheet() async {
        var written: [(String, Int?)] = []
        let editor = MessageEditor(attachments: 0, read: { answer("Add retries", revision: 7) }) { words, revision in
            written.append((words, revision))
            return nil
        }
        await editor.load()
        editor.text = "Add retries now"
        #expect(await editor.save())
        #expect(written.map(\.0) == ["Add retries now"])
        #expect(written.map(\.1) == [7])
        #expect(editor.problem == nil)
    }

    @Test func aRefusedSaveKeepsTheEditedWordsAndSaysWhy() async {
        let editor = MessageEditor(attachments: 0, read: { answer("Add retries") }) { _, _ in
            "Couldn't reach your computer. Try again."
        }
        await editor.load()
        editor.text = "Add retries with backoff"
        #expect(await editor.save() == false)
        #expect(editor.text == "Add retries with backoff")
        #expect(editor.problem == "Couldn't reach your computer. Try again.")
        #expect(editor.newer == nil)
    }

    @Test func aMessageChangedElsewhereShowsTheNewerWordsKeepsTheEditAndSavesOverItOnPurpose() async {
        var reads = [answer("Version A", revision: 3), answer("Version B", revision: 5)]
        var written: [Int?] = []
        let editor = MessageEditor(attachments: 0, read: { reads.removeFirst() }) { _, revision in
            written.append(revision)
            return revision == 3 ? "queue_conflict" : nil
        }
        await editor.load()
        editor.text = "Version A, edited"
        #expect(await editor.save() == false)
        #expect(editor.text == "Version A, edited")
        #expect(editor.newer == "Version B")
        #expect(editor.problem == changedElsewhere)
        #expect(await editor.save())
        #expect(written == [3, 5])
    }

    @Test func nothingCanBeSavedUntilTheFullWordsAreRead() async {
        var wrote = false
        let editor = MessageEditor(attachments: 0, read: { WordsRequests.Answer(ok: false, text: nil, message: "Couldn't reach your computer.") },
                                   write: { _, _ in wrote = true; return nil })
        await editor.load()
        #expect(!editor.canSave)
        #expect(await editor.save() == false)
        #expect(!wrote)
        #expect(editor.problem == "Couldn't reach your computer.")
    }
}

/// Take-back rows an earlier build left in a machine's store: their words go into the thread's
/// draft once, and the row goes.
@Suite @MainActor struct LegacyTakeBacksTests {
    private func database(in directory: URL, host: String, takeBacks: String) throws -> URL {
        let url = directory.appendingPathComponent("machine.sqlite")
        var db: OpaquePointer?
        #expect(sqlite3_open(url.path, &db) == SQLITE_OK)
        defer { sqlite3_close(db) }
        let sql = "CREATE TABLE metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL);"
            + "INSERT INTO metadata VALUES ('host', '\(host)');"
            + "INSERT INTO metadata VALUES ('takeBacks', '\(takeBacks)');"
        #expect(sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK)
        return url
    }
    private func rows(_ url: URL) -> Int {
        var db: OpaquePointer?
        sqlite3_open(url.path, &db)
        defer { sqlite3_close(db) }
        var statement: OpaquePointer?
        sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM metadata WHERE id='takeBacks'", -1, &statement, nil)
        defer { sqlite3_finalize(statement) }
        sqlite3_step(statement)
        return Int(sqlite3_column_int(statement, 0))
    }

    @Test func leftWordsGoIntoTheThreadsDraftOnceAndTheRowGoes() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("legacy-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = try database(in: directory, host: "host-1",
                               takeBacks: #"[{"id":"r1","threadId":"thread-1","text":"Ship the release notes","kind":"queue","source":"m1"}]"#)
        let drafts = ThreadDrafts(url: directory.appendingPathComponent("drafts.json"))
        let key = ThreadDrafts.key(hostId: "host-1", threadId: "thread-1")
        drafts.save("Half a thought", for: key)
        LegacyTakeBacks.drain(databases: directory, into: drafts)
        #expect(drafts.text(for: key) == "Half a thought\n\nShip the release notes")
        #expect(rows(url) == 0)
        // A second launch finds nothing to add.
        LegacyTakeBacks.drain(databases: directory, into: drafts)
        #expect(drafts.text(for: key) == "Half a thought\n\nShip the release notes")
    }

    @Test func wordsTheDraftAlreadyHoldsAreNotAddedAgain() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("legacy-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = try database(in: directory, host: "host-1",
                               takeBacks: #"[{"id":"r1","threadId":"thread-1","text":"Ship it","kind":"send","source":"c1"}]"#)
        let drafts = ThreadDrafts(url: directory.appendingPathComponent("drafts.json"))
        let key = ThreadDrafts.key(hostId: "host-1", threadId: "thread-1")
        // An earlier launch put the words in, then stopped before the row went.
        drafts.save("Ship it", for: key)
        LegacyTakeBacks.drain(databases: directory, into: drafts)
        #expect(drafts.text(for: key) == "Ship it")
        #expect(rows(url) == 0)
    }
}
