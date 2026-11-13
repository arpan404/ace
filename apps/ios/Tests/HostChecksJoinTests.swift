import Foundation
import Testing
@testable import Ace

/// Diagnostics waits on a checks run going on the machine; a new connection waits on it again.
@MainActor @Suite struct HostChecksJoinTests {
    private static let read: [String: Any] = ["type": "host.diagnostics"]

    private func run(_ state: String, id: String? = "run-1") throws -> HostChecksReply {
        var json: [String: Any] = ["state": state, "lead": "", "note": "", "summary": "", "rows": []]
        if let id { json["runId"] = id }
        return try JSONDecoder().decode(HostChecksReply.self, from: JSONSerialization.data(withJSONObject: json))
    }
    private func join(_ checks: HostChecksReply?, _ model: ClientModel) -> HostChecksJoin? {
        HostChecksJoin(checks: checks, reconnects: model.reads.reconnects, generation: model.readGeneration(Self.read))
    }

    @Test func aRunStillGoingAfterTheMachineComesBackIsJoinedAgain() throws {
        let model = ClientModel(now: { 0 })
        let running = try run("running")
        let before = try #require(join(running, model))
        model.receive(try JSONSerialization.data(withJSONObject: [["type": "service.generations", "generations": ["reconnects": 1]]]))
        let after = try #require(join(running, model))
        #expect(after.runId == before.runId)
        #expect(after != before)
    }

    @Test func nothingIsJoinedUnlessARunWithAnIdIsGoing() throws {
        let model = ClientModel(now: { 0 })
        #expect(join(nil, model) == nil)
        #expect(join(try run("done"), model) == nil)
        #expect(join(try run("running", id: nil), model) == nil)
    }
}
