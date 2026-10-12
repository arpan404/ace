import Foundation
import SQLite3

/// Confined to the host's storage queue. Record and binding writes commit before their JSC promises resolve.
final class DurableStore {
    private var db: OpaquePointer?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            throw HostError.storage
        }
        try execute("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL);")
    }
    deinit { sqlite3_close(db) }

    func perform(_ operation: String, input: Data) throws -> String {
        switch operation {
        case "storage.records":
            let values = try query("SELECT value FROM records ORDER BY id")
            return String(decoding: try JSONEncoder().encode(values), as: UTF8.self)
        case "storage.write":
            let value = try JSONDecoder().decode(RecordWrite.self, from: input)
            guard value.id.utf8.count <= 256, (value.value?.utf8.count ?? 0) <= 1_048_576 else { throw HostError.storage }
            try transaction {
                if let text = value.value {
                    try write("INSERT INTO records(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", [value.id, text])
                } else { try write("DELETE FROM records WHERE id=?", [value.id]) }
            }
            return ""
        case "storage.host.load": return try query("SELECT value FROM metadata WHERE id='host'").first ?? ""
        case "storage.host.save":
            let host = try JSONDecoder().decode(String.self, from: input)
            try transaction {
                let existing = try query("SELECT value FROM metadata WHERE id='host'").first
                guard existing == nil || existing == host else { throw HostError.identity }
                try write("INSERT OR IGNORE INTO metadata(id,value) VALUES ('host',?)", [host])
            }
            return ""
        case "storage.load": return try query("SELECT value FROM metadata WHERE id='legacy'").first ?? ""
        case "storage.save":
            let value = try JSONDecoder().decode(String.self, from: input)
            try transaction { try write("INSERT OR REPLACE INTO metadata(id,value) VALUES ('legacy',?)", [value]) }
            return ""
        default: throw HostError.unsupported
        }
    }
    private func transaction(_ run: () throws -> Void) throws {
        try execute("BEGIN IMMEDIATE")
        do { try run(); try execute("COMMIT") }
        catch { try? execute("ROLLBACK"); throw error }
    }
    private func execute(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw HostError.storage }
    }
    private func write(_ sql: String, _ values: [String]) throws {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw HostError.storage }
        defer { sqlite3_finalize(statement) }
        for (index, value) in values.enumerated() {
            guard sqlite3_bind_text(statement, Int32(index + 1), value, -1, transient) == SQLITE_OK else { throw HostError.storage }
        }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw HostError.storage }
    }
    private func query(_ sql: String) throws -> [String] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw HostError.storage }
        defer { sqlite3_finalize(statement) }
        var values: [String] = []
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_DONE { return values }
            guard result == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else { throw HostError.storage }
            values.append(String(cString: text))
        }
    }
}
struct RecordWrite: Codable { let id: String; let value: String? }
enum HostError: Error { case storage, identity, unsupported, encoding, entropy, transport }
