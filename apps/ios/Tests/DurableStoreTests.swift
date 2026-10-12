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
            _ = try store.perform("storage.write", input: JSONEncoder().encode(RecordWrite(id: "one", value: "First")))
            _ = try store.perform("storage.write", input: JSONEncoder().encode(RecordWrite(id: "two", value: "Second")))
            _ = try store.perform("storage.write", input: JSONEncoder().encode(RecordWrite(id: "one", value: nil)))
        }
        let reopened = try DurableStore(url: path)
        let values = try reopened.perform("storage.records", input: Data("null".utf8))
        #expect(try JSONDecoder().decode([String].self, from: Data(values.utf8)) == ["Second"])
    }
    @Test func aDifferentDaemonCannotOverwriteThePersistedIdentity() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DurableStore(url: root.appendingPathComponent("outbox.sqlite"))
        _ = try store.perform("storage.host.save", input: JSONEncoder().encode("original"))
        #expect(throws: HostError.self) { _ = try store.perform("storage.host.save", input: JSONEncoder().encode("different")) }
        #expect(try store.perform("storage.host.load", input: Data("null".utf8)) == "original")
    }
}
