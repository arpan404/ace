import Foundation
import SQLite3

/// Builds from 2026-10-27 kept "take-back" records (words on their way back to a composer) in each
/// machine's store, `metadata.takeBacks`. Nothing reads them any more: at launch each one's words go
/// into that thread's saved draft once, after what it holds, and the row goes. Words a draft already
/// holds aren't added again, so a launch that stops between the two steps never doubles them.
enum LegacyTakeBacks {
    private struct Record: Decodable { let threadId: String; let text: String }

    @MainActor static func drain(databases directory: URL, into drafts: ThreadDrafts) {
        guard let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil,
                                                         options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return }
        for case let url as URL in files where url.pathExtension == "sqlite" {
            drain(database: url, into: drafts)
        }
    }

    @MainActor static func drain(database url: URL, into drafts: ThreadDrafts) {
        var db: OpaquePointer?
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else { sqlite3_close(db); return }
        defer { sqlite3_close(db) }
        guard let kept = value(db, "takeBacks") else { return }
        if let hostId = value(db, "host"), let records = try? JSONDecoder().decode([Record].self, from: Data(kept.utf8)) {
            for record in records where !record.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let key = ThreadDrafts.key(hostId: hostId, threadId: record.threadId)
                let draft = drafts.text(for: key)
                guard !draft.contains(record.text) else { continue }
                drafts.save(ComposerRestore(text: record.text).merged(into: draft), picks: drafts.picks(for: key), for: key)
            }
        }
        sqlite3_exec(db, "DELETE FROM metadata WHERE id='takeBacks'", nil, nil, nil)
    }

    private static func value(_ db: OpaquePointer?, _ id: String) -> String? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT value FROM metadata WHERE id=?", -1, &statement, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, id, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        guard sqlite3_step(statement) == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else { return nil }
        return String(cString: text)
    }
}
