import Foundation
import Testing
@testable import Ace

@Suite struct DurableStoreTests {
    @Test func committedRecordsSurviveReopeningAndReceiptsDeleteOnlyTheirOwnInput() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let path = root.appendingPathComponent("outbox.sqlite")
        do {
            let store = try DurableStore(url: path)
            _ = try store.perform("storage.write", input: Data(#"{"id":"one"}"#.utf8), body: "First")
            _ = try store.perform("storage.write", input: Data(#"{"id":"two"}"#.utf8), body: "Second")
            _ = try store.perform("storage.write", input: Data(#"{"id":"one"}"#.utf8))
        }
        let reopened = try DurableStore(url: path)
        let values = try reopened.perform("storage.records", input: Data("null".utf8))
        #expect(try JSONDecoder().decode([String].self, from: Data(values.utf8)) == ["Second"])
    }
    @Test func aDifferentDaemonCannotOverwriteThePersistedIdentity() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DurableStore(url: root.appendingPathComponent("outbox.sqlite"))
        _ = try store.perform("storage.host.save", body: "original")
        #expect(throws: HostError.self) { _ = try store.perform("storage.host.save", body: "different") }
        #expect(try store.perform("storage.host.load", input: Data("null".utf8)) == "original")
    }
    @Test func keptReadsSurviveReopeningAndTheNewestRecordReplacesTheOld() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let path = root.appendingPathComponent("outbox.sqlite")
        do {
            let store = try DurableStore(url: path)
            #expect(try store.perform("storage.reads.load", input: Data("null".utf8)) == "")
            _ = try store.perform("storage.reads.save", body: #"{"version":1,"reads":[]}"#)
            _ = try store.perform("storage.reads.save", body: #"{"version":1,"reads":[{"key":"k"}]}"#)
        }
        let reopened = try DurableStore(url: path)
        #expect(try reopened.perform("storage.reads.load", input: Data("null".utf8)) == #"{"version":1,"reads":[{"key":"k"}]}"#)
    }
}
