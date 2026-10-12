import Foundation
import Testing
@testable import Ace

@MainActor extension BridgeContractTests {
    @Test func threeHundredLargeActionsArriveThroughSDKSnapshotFragmentsAndResolveExactly() async throws {
        let id = "ios-many-normal"
        try await createMany(id)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = ClientModel(now: { 0 })
        defer { Task { await model.disconnectAndWait(); try? FileManager.default.removeItem(at: root) } }
        model.connect(target: try manyTarget(), directory: root)
        try await untilMany { model.connection == "ready" }
        model.open(id)
        try await untilMany { model.thread?.approvals.first?.options.count == 300 }
        let approval = try #require(model.thread?.approvals.first)
        let option = try #require(approval.options.last)
        #expect(option.id == "action-299-" + String(repeating: "x", count: 32768))
        #expect(model.error == nil)
        #expect(model.largestFrame <= 32768)
        model.approve(approval, option: option)
        try await untilMany { model.thread?.interactions[approval.id]?.state == "resolved" }
        try await verifyResolution(thread: id, interaction: approval.id, option: option.id)
    }

    @Test func rejectingTheFinalLargeFrameRedeliversTheApprovalAndItsActions() async throws {
        let id = "ios-many-rejected"
        try await createMany(id)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let consumer = RejectOnceConsumer()
        let runtime = ClientRuntime(target: try manyTarget(), storageURL: root.appendingPathComponent("outbox.sqlite"), receive: { [weak consumer] data in
            Task { @MainActor in consumer?.receive(data) }
        }, fail: { [weak consumer] message in Task { @MainActor in consumer?.model.error = message } })
        consumer.runtime = runtime
        defer { Task { await withCheckedContinuation { continuation in runtime.stop { continuation.resume() } }; try? FileManager.default.removeItem(at: root) } }
        runtime.start()
        try await untilMany { consumer.model.connection == "ready" }
        consumer.model.open(id)
        runtime.invoke("aceAction", json: String(decoding: try JSONSerialization.data(withJSONObject: ["type": "open", "threadId": id]), as: UTF8.self))
        try await untilMany { consumer.model.thread?.approvals.first?.options.count == 300 }
        #expect(consumer.rejected)
        #expect(consumer.wasAbsentAfterRejection)
        let approval = try #require(consumer.model.thread?.approvals.first)
        let option = try #require(approval.options.last)
        #expect(option.id == "action-299-" + String(repeating: "x", count: 32768))
        let action: [String: Any] = ["type": "command", "requestId": "test-retry", "payload": ["type": "interaction.resolve", "interactionId": approval.id, "resolution": ["kind": "approval", "optionId": option.id]]]
        runtime.invoke("aceAction", json: String(decoding: try JSONSerialization.data(withJSONObject: action), as: UTF8.self))
        try await untilMany { consumer.model.thread?.interactions[approval.id]?.state == "resolved" }
        try await verifyResolution(thread: id, interaction: approval.id, option: option.id)
    }

    private func manyTarget() throws -> ConnectionTarget {
        ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:9841")), hostId: "ios-spike-host", deviceId: "ios-contract-device", pin: nil, credential: { "{\"token\":\"ios-spike-token\"}" })
    }
    private func createMany(_ id: String) async throws {
        var request = URLRequest(url: try #require(URL(string: "http://127.0.0.1:9841/review/many")))
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(CreateScenario(id: id))
        let (_, response) = try await URLSession.shared.data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
    }
    private func verifyResolution(thread: String, interaction: String, option: String) async throws {
        let (data, _) = try await URLSession.shared.data(from: #require(URL(string: "http://127.0.0.1:9841/state?thread=\(thread)")))
        let state = try JSONDecoder().decode(CanonicalState.self, from: data)
        #expect(state.interactions[interaction]?.resolution?.optionId == option)
        let (health, _) = try await URLSession.shared.data(from: #require(URL(string: "http://127.0.0.1:9841/health")))
        #expect(try JSONDecoder().decode(Health.self, from: health).fragmentParts > 0)
    }
    private func untilMany(_ condition: () -> Bool) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(25))
        while !condition() {
            if clock.now >= deadline { throw ApprovalContractError.timeout }
            try await Task.sleep(for: .milliseconds(25))
        }
    }
}

@MainActor private final class RejectOnceConsumer {
    let model = ClientModel(now: { 0 })
    var runtime: ClientRuntime?
    var rejected = false
    var wasAbsentAfterRejection = false
    func receive(_ data: Data) {
        let probe = try? JSONDecoder().decode([FragmentProbe].self, from: data)
        let accepted: Bool
        if !rejected, probe?.first?.type == "fragment", probe?.first?.last == true {
            rejected = true
            accepted = model.receive(Data("invalid final frame".utf8))
            wasAbsentAfterRejection = model.thread?.approvals.isEmpty == true
        } else { accepted = model.receive(data) }
        runtime?.acknowledge(accepted: accepted)
    }
}
private struct FragmentProbe: Decodable { let type: String; let last: Bool? }
private struct CreateScenario: Encodable { let id: String }
private struct Health: Decodable { let fragmentParts: Int }
private struct CanonicalState: Decodable {
    struct Interaction: Decodable { struct Resolution: Decodable { let optionId: String? }; let resolution: Resolution? }
    let interactions: [String: Interaction]
}
private enum ApprovalContractError: Error { case timeout }
