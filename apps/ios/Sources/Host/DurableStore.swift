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

    func perform(_ request: HostRequest) throws -> String {
        switch request.operation {
        case "storage.records":
            let values = try query("SELECT value FROM records ORDER BY id")
            return String(decoding: try JSONEncoder().encode(values), as: UTF8.self)
        case "storage.write":
            // No body deletes the record.
            let id = try JSONDecoder().decode(RecordId.self, from: request.input).id
            guard id.utf8.count <= 256, (request.body?.utf8.count ?? 0) <= 1_048_576 else { throw HostError.storage }
            try transaction {
                if let text = request.body {
                    try write("INSERT INTO records(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", [id, text])
                } else { try write("DELETE FROM records WHERE id=?", [id]) }
            }
            return ""
        case "storage.host.load": return try query("SELECT value FROM metadata WHERE id='host'").first ?? ""
        case "storage.host.save":
            let host = try request.requireBody()
            try transaction {
                let existing = try query("SELECT value FROM metadata WHERE id='host'").first
                guard existing == nil || existing == host else { throw HostError.identity }
                try write("INSERT OR IGNORE INTO metadata(id,value) VALUES ('host',?)", [host])
            }
            return ""
        case "storage.load": return try query("SELECT value FROM metadata WHERE id='legacy'").first ?? ""
        case "storage.save":
            let value = try request.requireBody()
            try transaction { try write("INSERT OR REPLACE INTO metadata(id,value) VALUES ('legacy',?)", [value]) }
            return ""
        // The bridge's kept reads (`bridge/read-cache.ts`): a cache, so a plain replace.
        case "storage.reads.load": return try query("SELECT value FROM metadata WHERE id='reads'").first ?? ""
        case "storage.reads.save":
            let value = try request.requireBody()
            guard value.utf8.count <= 8 * 1_048_576 else { throw HostError.storage }
            try transaction { try write("INSERT OR REPLACE INTO metadata(id,value) VALUES ('reads',?)", [value]) }
            return ""
        // The browser's device toolbar per tab (`bridge/browser-device.ts`): a plain replace.
        case "storage.devices.load": return try query("SELECT value FROM metadata WHERE id='browserDevices'").first ?? ""
        case "storage.devices.save":
            let value = try request.requireBody()
            guard value.utf8.count <= 1_048_576 else { throw HostError.storage }
            try transaction { try write("INSERT OR REPLACE INTO metadata(id,value) VALUES ('browserDevices',?)", [value]) }
            return ""
        // Failed sends the person took back or discarded (`bridge/dismissed-sends.ts`): a plain replace.
        case "storage.dismissed.load": return try query("SELECT value FROM metadata WHERE id='dismissedSends'").first ?? ""
        case "storage.dismissed.save":
            let value = try request.requireBody()
            guard value.utf8.count <= 65_536 else { throw HostError.storage }
            try transaction { try write("INSERT OR REPLACE INTO metadata(id,value) VALUES ('dismissedSends',?)", [value]) }
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
private struct RecordId: Decodable { let id: String }
enum HostError: Error { case storage, identity, unsupported, encoding, entropy, transport }
