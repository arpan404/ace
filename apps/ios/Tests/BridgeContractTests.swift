import Foundation
import Testing
@testable import Ace

/// Runs against the real local socket fixture. No provider CLI is invoked.
@Suite(.serialized) @MainActor struct BridgeContractTests {
    @Test func oversizedDetailsKeepCanonicalWorkingStateAndExactApprovalActions() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = ClientModel(now: { 0 })
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        model.connect(target: try target(), directory: root)
        try await until { model.connection == "ready" }
        func stage(_ value: String) async throws {
            var request = URLRequest(url: try #require(URL(string: "http://127.0.0.1:9841/review/oversized")))
            request.httpMethod = "POST"
            request.httpBody = try JSONEncoder().encode(value)
            let (_, response) = try await URLSession.shared.data(for: request)
            #expect((response as? HTTPURLResponse)?.statusCode == 200)
        }
        try await stage("create")
        try await until("large thread starts done") { model.inbox["ios-large"]?.state == "done" }
        try await stage("work")
        try await until("large title keeps working status") { model.inbox["ios-large"]?.state == "working" }
        #expect(model.inbox["ios-large"]?.title.hasPrefix("Large working title") == true)
        model.open("ios-large")
        try await until("large thread loads") { model.thread?.loaded == true }
        try await stage("approval")
        try await until("large approval arrives") { model.thread?.approvals.isEmpty == false }
        let approval = try #require(model.thread?.approvals.first)
        #expect(approval.truncated)
        #expect(approval.command.hasPrefix("printf "))
        let option = try #require(approval.options.first)
        #expect(option.id == "option-" + String(repeating: "x", count: 40000))
        model.approve(approval, option: option)
        try await until { model.thread?.approvals.isEmpty == true }
        #expect(model.error == nil)
        #expect(model.largestFrame <= 32768)
    }
    @Test func theSharedClientStreamsTwoThousandItemsAndKeepsALiveChildWorking() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = ClientModel(now: { 0 })
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        model.connect(target: try target(), directory: root, itemLimit: 2200)
        try await until { model.connection == "ready" && model.inbox["ios-tree"] != nil }
        #expect(model.inbox["ios-tree"]?.state == "working")
        model.open("ios-stream")
        try await until { (model.thread?.items.count ?? 0) >= 2000 && model.thread?.loaded == true }
        let text = model.thread?.items.values.first { !$0.row.complete }?.row.text
        try await until { model.thread?.items.values.first { !$0.row.complete }?.row.text != text }
        #expect(model.error == nil)
        #expect(model.largestFrame <= 32768)
        #expect((model.thread?.order.count ?? 0) >= 2000)
    }
    @Test func offlineInputSurvivesRuntimeDestructionAndIsAdmittedOnce() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let original = ClientModel(now: { 0 })
        original.connect(target: try target(), directory: root, itemLimit: 2200)
        try await until { original.connection == "ready" }
        original.open("ios-stream")
        try await until { original.thread?.loaded == true }
        original.network(false)
        try await until { original.connection == "offline" }
        let text = "Offline bridge contract \(UUID().uuidString)"
        original.send(text, delivery: "queue")
        try await until { original.pending.values.contains { $0.text == text && $0.state == "sent" } }
        await original.disconnectAndWait()
        let restored = ClientModel(now: { 0 })
        defer { Task { await restored.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        restored.connect(target: try target(), directory: root, itemLimit: 2200)
        restored.open("ios-stream")
        try await until { restored.connection == "ready" && restored.thread?.loaded == true && restored.thread?.items.values.contains { $0.row.text == text } == true }
        #expect(restored.thread?.items.values.filter { $0.row.text == text }.count == 1)
        #expect(restored.error == nil)
        let store = try DurableStore(url: database(in: root))
        try await until { (try? store.perform("storage.records", input: Data("null".utf8))) == "[]" }
    }
    @Test func approvalClosesOnlyAfterTheCanonicalDaemonUpdate() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = ClientModel(now: { 0 })
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        model.connect(target: try target(), directory: root)
        try await until { model.connection == "ready" }
        model.open("ios-approval")
        try await until { model.thread?.approvals.isEmpty == false }
        let approval = try #require(model.thread?.approvals.first)
        let deny = try #require(approval.options.first { $0.kind == "deny" })
        model.approve(approval, option: deny)
        try await until { model.thread?.interactions[approval.id]?.state == "resolved" }
        #expect(model.thread?.approvals.isEmpty == true)
    }
    private func target() throws -> ConnectionTarget {
        ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:9841")), hostId: "ios-spike-host", deviceId: "ios-contract-device", pin: nil,
                         credential: { "{\"token\":\"ios-spike-token\"}" })
    }
    private func database(in root: URL) -> URL {
        (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first { $0.pathExtension == "sqlite" }) ?? root
    }
    private func until(_ label: String = "condition", _ condition: () -> Bool) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(25))
        while !condition() {
            if clock.now >= deadline { throw ContractError.timeout(label) }
            try await Task.sleep(for: .milliseconds(25))
        }
    }
}
private enum ContractError: Error { case timeout(String) }
