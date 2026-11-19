import Foundation
import Testing
@testable import Ace

/// The SDK's read snapshots on this phone (`bridge/read-snapshots.ts`): kept across launches,
/// threads as one row per item, listed for the shared retention rules, and cleared when the daemon
/// refuses the credential.
@Suite struct SnapshotStoreTests {
    @Test func aRecordSurvivesReopeningAndAMissReadsEmpty() throws {
        let database = try temporaryDatabase()
        defer { try? FileManager.default.removeItem(at: database.deletingLastPathComponent()) }
        let clock = Clock()
        try SnapshotStore(database: database, now: clock.now).perform("snapshot.set", input: keyed("host/sidebar"), body: "[1]")
        let reopened = try SnapshotStore(database: database, now: clock.now)
        #expect(try reopened.perform("snapshot.get", input: key("host/sidebar")) == "[1]")
        #expect(try reopened.perform("snapshot.get", input: key("host/other")) == "")
    }

    @Test func aThreadIsKeptAsOneRowPerItemAndAWriteChangesOnlyTheRowsItNames() throws {
        let database = try temporaryDatabase()
        defer { try? FileManager.default.removeItem(at: database.deletingLastPathComponent()) }
        let store = try SnapshotStore(database: database, now: Clock().now)
        try put(store, "host/thread:t", ids: ["a", "b"], body: "{\"h\":1}\n{\"id\":\"a\"}\n{\"id\":\"b\",\"t\":\"x\"}")
        try put(store, "host/thread:t", ids: ["b"], body: "{\"h\":2}\n{\"id\":\"b\",\"t\":\"xy\"}")
        let reopened = try SnapshotStore(database: database, now: Clock().now)
        let lines = try #require(try reopened.perform("snapshot.thread.get", input: key("host/thread:t"))).split(separator: "\n").map(String.init)
        #expect(lines.first == "{\"h\":2}")
        #expect(Set(lines.dropFirst()) == ["{\"id\":\"a\"}", "{\"id\":\"b\",\"t\":\"xy\"}"])
        try put(store, "host/thread:t", ids: [], removed: ["a"], body: "{\"h\":3}")
        #expect(try store.perform("snapshot.thread.get", input: key("host/thread:t")) == "{\"h\":3}\n{\"id\":\"b\",\"t\":\"xy\"}")
        try put(store, "host/thread:t", ids: ["c"], replace: true, body: "{\"h\":4}\n{\"id\":\"c\"}")
        #expect(try store.perform("snapshot.thread.get", input: key("host/thread:t")) == "{\"h\":4}\n{\"id\":\"c\"}")
    }

    @Test func aWriteWhoseLinesDoNotMatchItsIdsChangesNothing() throws {
        let database = try temporaryDatabase()
        defer { try? FileManager.default.removeItem(at: database.deletingLastPathComponent()) }
        let store = try SnapshotStore(database: database, now: Clock().now)
        try put(store, "host/thread:t", ids: ["a"], body: "{}\n{\"id\":\"a\"}")
        #expect(throws: HostError.self) { try put(store, "host/thread:t", ids: ["b", "c"], replace: true, body: "{}\n{\"id\":\"b\"}") }
        #expect(try store.perform("snapshot.thread.get", input: key("host/thread:t")) == "{}\n{\"id\":\"a\"}")
    }

    @Test func theIndexListsEachEntrysLastUseSizeAndSettlementAndDropLetsThemGo() throws {
        let database = try temporaryDatabase()
        defer { try? FileManager.default.removeItem(at: database.deletingLastPathComponent()) }
        let clock = Clock()
        let store = try SnapshotStore(database: database, now: clock.now)
        _ = try store.perform("snapshot.set", input: keyed("host/sidebar"), body: "[1]")
        clock.tick()
        try put(store, "host/thread:t", ids: ["a"], settled: true, body: "{}\n{\"id\":\"a\"}")
        let index = try JSONDecoder().decode([Kept].self, from: Data(try #require(try store.perform("snapshot.index")).utf8))
        #expect(index.sorted { $0.key < $1.key } == [
            Kept(key: "host/sidebar", kind: "record", used: 1_000_000, bytes: 3, settled: false),
            Kept(key: "host/thread:t", kind: "thread", used: 1_001_000, bytes: 12, settled: true),
        ])
        _ = try store.perform("snapshot.drop", input: try JSONEncoder().encode(["keys": ["host/thread:t", "host/sidebar"]]))
        #expect(try store.perform("snapshot.index") == "[]")
        #expect(try store.perform("snapshot.thread.get", input: key("host/thread:t")) == "")
    }

    @Test func clearingDropsEveryRecord() throws {
        let database = try temporaryDatabase()
        defer { try? FileManager.default.removeItem(at: database.deletingLastPathComponent()) }
        let store = try SnapshotStore(database: database, now: Clock().now)
        _ = try store.perform("snapshot.set", input: keyed("a"), body: "1")
        try put(store, "host/thread:t", ids: ["a"], body: "{}\n{}")
        _ = try store.perform("snapshot.clear", input: Data("null".utf8))
        #expect(try store.perform("snapshot.get", input: key("a")) == "")
        #expect(try store.perform("snapshot.index") == "[]")
    }

    private func temporaryDatabase() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("machine.sqlite")
    }
    @Test func clearingGivesTheSpaceBack() throws {
        let database = try temporaryDatabase()
        defer { try? FileManager.default.removeItem(at: database.deletingLastPathComponent()) }
        let store = try SnapshotStore(database: database, now: Clock().now)
        let item = "{\"id\":\"a\",\"t\":\"\(String(repeating: "x", count: 500_000))\"}"
        try put(store, "host/thread:t", ids: ["a"], body: "{}\n\(item)")
        let full = try bytes(store)
        _ = try store.perform("snapshot.clear")
        let cleared = try bytes(store)
        #expect(full > 500_000)
        #expect(cleared < 64 * 1024)
    }

    private func bytes(_ store: SnapshotStore) throws -> Int {
        let text = try store.perform("snapshot.size") ?? ""
        return try #require(Int(text))
    }
    private func put(_ store: SnapshotStore, _ key: String, ids: [String], removed: [String] = [], replace: Bool = false,
                     settled: Bool = false, body: String) throws {
        let input = try JSONSerialization.data(withJSONObject: ["key": key, "settled": settled, "ids": ids, "removed": removed, "replace": replace])
        _ = try store.perform("snapshot.thread.put", input: input, body: body)
    }
    private func key(_ key: String) throws -> Data { try JSONEncoder().encode(key) }
    private func keyed(_ key: String) throws -> Data { try JSONEncoder().encode(["key": key]) }
}

private struct Kept: Decodable, Equatable { let key: String; let kind: String; let used: Double; let bytes: Int; let settled: Bool }

private final class Clock: @unchecked Sendable {
    private var at = Date(timeIntervalSince1970: 1_000)
    func tick() { at = at.addingTimeInterval(1) }
    var now: () -> Date { { self.at } }
}
