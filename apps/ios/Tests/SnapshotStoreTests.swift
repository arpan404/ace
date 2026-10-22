import Foundation
import Testing
@testable import Ace

/// The SDK's read snapshots on this phone (`bridge/read-snapshots.ts`): kept across launches,
/// bounded, least recently used first out, and cleared when the daemon refuses the credential.
@Suite struct SnapshotStoreTests {
    @Test func aRecordSurvivesReopeningAndAMissReadsEmpty() throws {
        let database = try temporaryDatabase()
        defer { try? FileManager.default.removeItem(at: database.deletingLastPathComponent()) }
        let clock = Clock()
        try SnapshotStore(database: database, now: clock.now).perform("snapshot.set", input: write("host/sidebar", "[1]"))
        let reopened = try SnapshotStore(database: database, now: clock.now)
        #expect(try reopened.perform("snapshot.get", input: key("host/sidebar")) == "[1]")
        #expect(try reopened.perform("snapshot.get", input: key("host/other")) == "")
    }

    @Test func overTheCountTheRecordReadLeastRecentlyGoesFirst() throws {
        let database = try temporaryDatabase()
        defer { try? FileManager.default.removeItem(at: database.deletingLastPathComponent()) }
        let clock = Clock()
        let store = try SnapshotStore(database: database, now: clock.now)
        for index in 0..<SnapshotStore.maxEntries {
            clock.tick()
            _ = try store.perform("snapshot.set", input: write("k\(index)", "v\(index)"))
        }
        // Reading the oldest makes it recent: the second oldest is evicted instead.
        clock.tick()
        _ = try store.perform("snapshot.get", input: key("k0"))
        clock.tick()
        _ = try store.perform("snapshot.set", input: write("new", "v"))
        #expect(try store.perform("snapshot.get", input: key("k0")) == "v0")
        #expect(try store.perform("snapshot.get", input: key("k1")) == "")
        #expect(try store.perform("snapshot.get", input: key("new")) == "v")
    }

    @Test func clearingDropsEveryRecord() throws {
        let database = try temporaryDatabase()
        defer { try? FileManager.default.removeItem(at: database.deletingLastPathComponent()) }
        let store = try SnapshotStore(database: database, now: Clock().now)
        _ = try store.perform("snapshot.set", input: write("a", "1"))
        _ = try store.perform("snapshot.clear", input: Data("null".utf8))
        #expect(try store.perform("snapshot.get", input: key("a")) == "")
    }

    private func temporaryDatabase() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("machine.sqlite")
    }
    private func key(_ key: String) throws -> Data { try JSONEncoder().encode(key) }
    private func write(_ key: String, _ value: String) throws -> Data { try JSONEncoder().encode(["key": key, "value": value]) }
}

private final class Clock: @unchecked Sendable {
    private var at = Date(timeIntervalSince1970: 1_000)
    func tick() { at = at.addingTimeInterval(1) }
    var now: () -> Date { { self.at } }
}
