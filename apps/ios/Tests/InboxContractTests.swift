import Foundation
import Testing
@testable import Ace

/// The inbox through the real bridge, SDK and local socket fixture. No provider CLI is invoked.
@Suite(.serialized) @MainActor struct InboxContractTests {
    @Test func theSharedGroupingKeepsAFinishedRootWithAWorkingChildUnderWorking() async throws {
        // A fresh pending approval: other contract tests resolve the fixture's own.
        var request = URLRequest(url: try #require(URL(string: "http://127.0.0.1:\(SpikeFixture.port)/review/many")))
        request.httpMethod = "POST"
        request.httpBody = Data(#"{"id":"ios-many-inbox"}"#.utf8)
        _ = try await URLSession.shared.data(for: request) // Repeated runs reuse the thread.
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        try await until("sections arrive") { section(model, of: "ios-tree") != nil && section(model, of: "ios-many-inbox") != nil }
        #expect(section(model, of: "ios-tree")?.label == "Working")
        #expect(model.inbox["ios-tree"]?.status == StatusDisplay(label: "Working", token: "working"))
        #expect(section(model, of: "ios-many-inbox")?.label == "Needs you")
        #expect(model.inbox["ios-many-inbox"]?.status == StatusDisplay(label: "Needs you", token: "needsYou"))
        #expect(section(model, of: "ios-done")?.label == "Done")
        #expect(model.inbox["ios-tree"]?.machineId == "ios-spike-host")
        let order = model.inboxLayout.sections.map(\.key)
        #expect(order.firstIndex(of: "needs-you") ?? 0 < order.firstIndex(of: "working") ?? 0)
        #expect(model.inboxLayout.snooze.map(\.id) == ["hour", "tomorrow", "monday"])
    }
    @Test func snoozeWakeArchiveAndUndoAreAdmittedDurablyAndMoveTheRowCanonically() async throws {
        let (model, root) = try await connected()
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        try await until("done row arrives") { section(model, of: "ios-done")?.key == "done" }
        #expect(await model.snooze("ios-done", preset: "hour"))
        try await until("row moves to Snoozed") { section(model, of: "ios-done")?.key == "snoozed" }
        #expect((model.inbox["ios-done"]?.snoozedUntil ?? 0) > Date().timeIntervalSince1970 * 1000)
        #expect(await model.wake("ios-done"))
        try await until("row wakes into Done") { section(model, of: "ios-done")?.key == "done" }
        #expect(await model.archive("ios-done"))
        try await until("archived row leaves the inbox") { section(model, of: "ios-done") == nil && model.inbox["ios-done"] == nil }
        #expect(await model.unarchive("ios-done"))
        try await until("undo restores the row") { section(model, of: "ios-done")?.key == "done" }
        #expect(model.error == nil)
    }

    private func section(_ model: ClientModel, of id: String) -> InboxLayout.Section? {
        model.inboxLayout.sections.first { $0.ids.contains(id) }
    }
    private func connected() async throws -> (ClientModel, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = ClientModel(now: { 0 })
        let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:\(SpikeFixture.port)")), hostId: "ios-spike-host", deviceId: "ios-inbox-device", pin: nil,
                                      credential: { "{\"token\":\"ios-spike-token\"}" })
        await model.connect(target: target, directory: root)
        try await until("connected") { model.connection == "ready" }
        return (model, root)
    }
    private func until(_ label: String, _ condition: () -> Bool) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(25))
        while !condition() {
            if clock.now >= deadline { throw InboxContractError.timeout(label) }
            try await Task.sleep(for: .milliseconds(25))
        }
    }
}
private enum InboxContractError: Error { case timeout(String) }
