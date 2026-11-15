import Foundation
import Testing
@testable import Ace

/// A needs-you row as the bridge publishes it (`inbox-needs.ts`): the count is the daemon's, a
/// read that stopped before finding every request says how many it read, and a request too large
/// to send offers only Open.
@Suite @MainActor struct NeedRowsTests {
    @Test func aRowCountsWhatTheDaemonCountsAndSaysWhenThePhoneReadFewer() throws {
        let model = waiting()
        model.receive(try json([needs(total: 231, loaded: 200, more: true, requests: [approval("ask-1")])]))
        #expect(model.needsCount("asking") == 231)
        #expect(model.needsLoaded("asking") == 200)
        #expect(NeedWords.position(total: model.needsCount("asking"), loaded: model.needsLoaded("asking")) == "1 of 231, 200 read")
    }

    @Test func aReadThatFoundThemAllSaysOnlyWhereTheShownOneStands() throws {
        let model = waiting()
        model.receive(try json([needs(total: 3, loaded: 3, more: false, requests: [approval("ask-1")])]))
        #expect(model.needsLoaded("asking") == nil)
        #expect(NeedWords.position(total: model.needsCount("asking"), loaded: model.needsLoaded("asking")) == "1 of 3")
        #expect(NeedWords.position(total: 1, loaded: nil) == nil)
    }

    @Test func anOlderBridgesRowWithoutReadCountsStillShows() throws {
        let model = waiting()
        var older = needs(total: 2, loaded: 0, more: false, requests: [approval("ask-1")])
        older.removeValue(forKey: "loaded")
        older.removeValue(forKey: "more")
        model.receive(try json([older]))
        #expect(model.needsYou("asking").map(\.id) == ["ask-1"])
        #expect(model.needsCount("asking") == 2)
        #expect(model.needsLoaded("asking") == nil)
    }

    @Test func aRequestTooLargeToSendIsCountedAndOffersOnlyOpen() throws {
        let model = waiting()
        let tooLarge: [String: Any] = [
            "id": "huge", "kind": "too_large", "state": "pending", "title": "A request too large to show here",
            "description": "Open it on your computer to see and answer it.", "command": "", "options": [],
            "truncated": true, "unanswerable": true,
        ]
        model.receive(try json([needs(total: 1, loaded: 1, more: false, requests: [tooLarge])]))
        let request = try #require(model.needsYou("asking").first)
        #expect(model.needsCount("asking") == 1)
        var opened = 0
        let actions = NeedActions(request: request, model: model, threadId: "asking", open: { opened += 1 }, review: {}, decided: {})
        #expect(actions.row.map(\.id) == ["open"])
        actions.row.first?.run()
        #expect(opened == 1)
    }

    /// A model whose inbox lists the asking thread as needing the person.
    private func waiting() -> ClientModel {
        let model = ClientModel(now: { 0 })
        model.receive(try! json([
            ["type": "inbox.reset", "ids": ["asking"]],
            ["type": "inbox.row", "id": "asking", "row": [
                "id": "asking", "title": "asking", "state": "needs_you", "project": "ace", "branch": "", "machine": "",
                "provider": "codex", "model": "", "agents": 1, "updatedAt": 1, "canSteer": false,
                "status": ["label": "Approve", "token": "needsYou"], "confirmed": true, "generation": 0,
            ] as [String: Any]],
        ]))
        return model
    }
    private func needs(total: Int, loaded: Int, more: Bool, requests: [[String: Any]]) -> [String: Any] {
        ["type": "inbox.needs", "id": "asking", "total": total, "loaded": loaded, "more": more, "requests": requests]
    }
    private func approval(_ id: String) -> [String: Any] {
        ["id": id, "kind": "approval", "state": "pending", "title": "Run a command", "description": "",
         "command": "make \(id)", "truncated": false,
         "options": [["id": "\(id):allow", "label": "Allow once", "kind": "allow_once"]]]
    }
    private func json(_ patches: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: patches) }
}
