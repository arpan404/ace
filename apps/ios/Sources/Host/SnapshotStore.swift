import Foundation
import SQLite3

/// The SDK's read snapshots for one machine (`bridge/read-snapshots.ts`), in a SQLite file beside
/// that machine's outbox and removed with it. A cache, not a record: writes are not synced to
/// disk before they resolve. Threads are kept as a head plus one row per item, so each item is
/// stored once (ADR 0105); other records are kept whole. The shared script decides what is
/// written and what goes (`@ace/client` `RowSnapshots`); this stores it, stamps each entry with
/// its last use, and lists what it holds. Confined to the host's storage queue.
final class SnapshotStore {
    static let suffix = "-snapshots.sqlite"
    /// One record or thread write larger than this is refused (a miss next launch).
    static let maxValue = 8 * 1024 * 1024

    private var db: OpaquePointer?
    private let url: URL
    private let now: () -> Date
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    static func url(database: URL) -> URL { URL(fileURLWithPath: database.path + suffix) }

    init(database: URL, now: @escaping () -> Date) throws {
        self.now = now
        let url = Self.url(database: database)
        self.url = url
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              sqlite3_exec(db, """
                PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
                CREATE TABLE IF NOT EXISTS snapshots (key TEXT PRIMARY KEY, value TEXT NOT NULL, bytes INTEGER NOT NULL, used REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS threads (key TEXT PRIMARY KEY, head TEXT NOT NULL, settled INTEGER NOT NULL, used REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS items (thread TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (thread, id)) WITHOUT ROWID;
                """, nil, nil, nil) == SQLITE_OK else {
            throw HostError.storage
        }
    }
    deinit { sqlite3_close(db) }

    /// `snapshot.get/set/clear` (whole records), `snapshot.thread.get/put` (threads as rows),
    /// `snapshot.index`, `snapshot.drop` and `snapshot.size` (bytes on disk). Answers nil for any other operation.
    func perform(_ request: HostRequest) throws -> String? {
        switch request.operation {
        case "snapshot.get":
            let key = try JSONDecoder().decode(String.self, from: request.input)
            guard let value = try texts("SELECT value FROM snapshots WHERE key=?", [.text(key)]).first else { return "" }
            try run("UPDATE snapshots SET used=? WHERE key=?", [.real(stamp()), .text(key)])
            return value
        case "snapshot.set":
            let key = try JSONDecoder().decode(SnapshotKey.self, from: request.input).key
            let value = try request.requireBody()
            let bytes = value.utf8.count
            guard key.utf8.count <= 1024, bytes <= Self.maxValue else { throw HostError.storage }
            try run("INSERT INTO snapshots(key,value,bytes,used) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, bytes=excluded.bytes, used=excluded.used",
                    [.text(key), .text(value), .integer(bytes), .real(stamp())])
            return ""
        case "snapshot.thread.get":
            let key = try JSONDecoder().decode(String.self, from: request.input)
            guard let head = try texts("SELECT head FROM threads WHERE key=?", [.text(key)]).first else { return "" }
            let items = try texts("SELECT value FROM items WHERE thread=?", [.text(key)])
            try run("UPDATE threads SET used=? WHERE key=?", [.real(stamp()), .text(key)])
            return ([head] + items).joined(separator: "\n")
        case "snapshot.thread.put":
            try put(try JSONDecoder().decode(ThreadWrite.self, from: request.input), body: try request.requireBody())
            return ""
        case "snapshot.index":
            return try index()
        case "snapshot.drop":
            let keys = try JSONDecoder().decode(DropKeys.self, from: request.input).keys
            try transaction {
                for key in keys {
                    try run("DELETE FROM snapshots WHERE key=?", [.text(key)])
                    try run("DELETE FROM threads WHERE key=?", [.text(key)])
                    try run("DELETE FROM items WHERE thread=?", [.text(key)])
                }
            }
            return ""
        case "snapshot.clear":
            try transaction {
                try run("DELETE FROM snapshots", [])
                try run("DELETE FROM threads", [])
                try run("DELETE FROM items", [])
            }
            // Give the space back: the person cleared the cache to free it.
            sqlite3_exec(db, "PRAGMA wal_checkpoint(TRUNCATE); VACUUM;", nil, nil, nil)
            return ""
        case "snapshot.size":
            let files = [url.path, url.path + "-wal", url.path + "-shm"]
            let bytes = files.reduce(0) { total, path in
                total + ((try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0)
            }
            return String(bytes)
        default: return nil
        }
    }

    /// The head line, then one line per id in `write.ids`; all of it lands or none of it.
    private func put(_ write: ThreadWrite, body: String) throws {
        guard write.key.utf8.count <= 1024, body.utf8.count <= Self.maxValue else { throw HostError.storage }
        // JSON never holds a raw newline, so each line is one whole value.
        let lines = body.utf8.split(separator: UInt8(ascii: "\n"), omittingEmptySubsequences: false).map { String(decoding: $0, as: UTF8.self) }
        guard lines.count == write.ids.count + 1 else { throw HostError.storage }
        try transaction {
            if write.replace { try run("DELETE FROM items WHERE thread=?", [.text(write.key)]) }
            for id in write.removed { try run("DELETE FROM items WHERE thread=? AND id=?", [.text(write.key), .text(id)]) }
            for (id, line) in zip(write.ids, lines.dropFirst()) {
                try run("INSERT INTO items(thread,id,value) VALUES (?,?,?) ON CONFLICT(thread,id) DO UPDATE SET value=excluded.value",
                        [.text(write.key), .text(id), .text(line)])
            }
            try run("INSERT INTO threads(key,head,settled,used) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET head=excluded.head, settled=excluded.settled, used=excluded.used",
                    [.text(write.key), .text(lines[0]), .integer(write.settled ? 1 : 0), .real(stamp())])
        }
    }

    /// Every record and thread with its last use and size in bytes.
    private func index() throws -> String {
        var kept: [Kept] = []
        let statement = try prepare("""
            SELECT key, 'record', used, bytes, 0 FROM snapshots
            UNION ALL
            SELECT t.key, 'thread', t.used, length(CAST(t.head AS BLOB)) + COALESCE((SELECT SUM(length(CAST(i.value AS BLOB))) FROM items i WHERE i.thread = t.key), 0), t.settled FROM threads t
            """, [])
        defer { sqlite3_finalize(statement) }
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_DONE { break }
            guard result == SQLITE_ROW, let key = sqlite3_column_text(statement, 0), let kind = sqlite3_column_text(statement, 1) else { throw HostError.storage }
            kept.append(Kept(key: String(cString: key), kind: String(cString: kind), used: sqlite3_column_double(statement, 2),
                             bytes: Int(sqlite3_column_int64(statement, 3)), settled: sqlite3_column_int(statement, 4) != 0))
        }
        return String(decoding: try JSONEncoder().encode(kept), as: UTF8.self)
    }

    private func stamp() -> Double { now().timeIntervalSince1970 * 1000 }

    private func transaction(_ body: () throws -> Void) throws {
        guard sqlite3_exec(db, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else { throw HostError.storage }
        do { try body(); guard sqlite3_exec(db, "COMMIT", nil, nil, nil) == SQLITE_OK else { throw HostError.storage } }
        catch { sqlite3_exec(db, "ROLLBACK", nil, nil, nil); throw error }
    }
    private enum Value { case text(String), integer(Int), real(Double) }
    private func prepare(_ sql: String, _ values: [Value]) throws -> OpaquePointer? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw HostError.storage }
        for (index, value) in values.enumerated() {
            let position = Int32(index + 1)
            let bound = switch value {
            case .text(let text): sqlite3_bind_text(statement, position, text, -1, transient)
            case .integer(let number): sqlite3_bind_int64(statement, position, Int64(number))
            case .real(let number): sqlite3_bind_double(statement, position, number)
            }
            guard bound == SQLITE_OK else { sqlite3_finalize(statement); throw HostError.storage }
        }
        return statement
    }
    private func run(_ sql: String, _ values: [Value]) throws {
        let statement = try prepare(sql, values)
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw HostError.storage }
    }
    private func texts(_ sql: String, _ values: [Value]) throws -> [String] {
        let statement = try prepare(sql, values)
        defer { sqlite3_finalize(statement) }
        var rows: [String] = []
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_DONE { return rows }
            guard result == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else { throw HostError.storage }
            rows.append(String(cString: text))
        }
    }
}
private struct SnapshotKey: Decodable { let key: String }
private struct DropKeys: Decodable { let keys: [String] }
private struct ThreadWrite: Decodable { let key: String; let settled: Bool; let ids: [String]; let removed: [String]; let replace: Bool }
private struct Kept: Encodable { let key: String; let kind: String; let used: Double; let bytes: Int; let settled: Bool }
