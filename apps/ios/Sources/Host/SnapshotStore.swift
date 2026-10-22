import Foundation
import SQLite3

/// The SDK's read snapshots for one machine (`bridge/read-snapshots.ts`), in a SQLite file beside
/// that machine's outbox and removed with it. A cache, not a record: writes are not synced to
/// disk before they resolve, and the least recently used records go once the file holds more
/// than `maxEntries` records or `maxBytes` of text. Confined to the host's storage queue.
final class SnapshotStore {
    static let suffix = "-snapshots.sqlite"
    static let maxEntries = 256
    static let maxBytes = 32 * 1024 * 1024
    /// One record larger than this is refused (a miss next launch) rather than evicting the rest.
    static let maxValue = 8 * 1024 * 1024

    private var db: OpaquePointer?
    private let now: () -> Date
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    static func url(database: URL) -> URL { URL(fileURLWithPath: database.path + suffix) }

    init(database: URL, now: @escaping () -> Date) throws {
        self.now = now
        let url = Self.url(database: database)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              sqlite3_exec(db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS snapshots (key TEXT PRIMARY KEY, value TEXT NOT NULL, bytes INTEGER NOT NULL, used REAL NOT NULL);", nil, nil, nil) == SQLITE_OK else {
            throw HostError.storage
        }
    }
    deinit { sqlite3_close(db) }

    /// `snapshot.get` (a key, answered with the text or "" for a miss), `snapshot.set` and `snapshot.clear`.
    func perform(_ operation: String, input: Data) throws -> String? {
        switch operation {
        case "snapshot.get":
            let key = try JSONDecoder().decode(String.self, from: input)
            guard let value = try text("SELECT value FROM snapshots WHERE key=?", key) else { return "" }
            try run("UPDATE snapshots SET used=? WHERE key=?", [.real(stamp()), .text(key)])
            return value
        case "snapshot.set":
            let record = try JSONDecoder().decode(SnapshotWrite.self, from: input)
            let bytes = record.value.utf8.count
            guard record.key.utf8.count <= 1024, bytes <= Self.maxValue else { throw HostError.storage }
            try run("INSERT INTO snapshots(key,value,bytes,used) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, bytes=excluded.bytes, used=excluded.used",
                    [.text(record.key), .text(record.value), .integer(bytes), .real(stamp())])
            try evict()
            return ""
        case "snapshot.clear":
            try run("DELETE FROM snapshots", [])
            return ""
        default: return nil
        }
    }

    private func stamp() -> Double { now().timeIntervalSince1970 * 1000 }
    /// Least recently used first, until both bounds hold.
    private func evict() throws {
        try run("""
            DELETE FROM snapshots WHERE key IN (
              SELECT key FROM (
                SELECT key, ROW_NUMBER() OVER (ORDER BY used DESC) AS position,
                       SUM(bytes) OVER (ORDER BY used DESC ROWS UNBOUNDED PRECEDING) AS total
                FROM snapshots)
              WHERE position > ? OR total > ?)
            """, [.integer(Self.maxEntries), .integer(Self.maxBytes)])
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
    private func text(_ sql: String, _ key: String) throws -> String? {
        let statement = try prepare(sql, [.text(key)])
        defer { sqlite3_finalize(statement) }
        let result = sqlite3_step(statement)
        if result == SQLITE_DONE { return nil }
        guard result == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else { throw HostError.storage }
        return String(cString: text)
    }
}
private struct SnapshotWrite: Decodable { let key: String; let value: String }
