import Foundation
import Testing
@testable import Ace

/// A needs-you row as the bridge publishes it (`inbox-needs.ts`): the line counts the requests
/// on this thread it can show, says apart how many wait in the thread's delegated work, says when
/// the phone's read stopped before finding them all, and a request too large to send offers only
/// Open.
@Suite @MainActor struct NeedRowsTests {
    @Test func requestsWaitingInDelegatedWorkAreSaidApartFromTheOnesThisRowShows() throws {
        // One approval on this thread; two requests in a delegated child thread.
        let model = waiting()
        model.receive(try json([needs(total: 3, loaded: 1, more: false, elsewhere: 2, requests: [approval("ask-1")])]))
        let tally = model.needsTally("asking")
        #expect(tally == NeedTally(here: 1, elsewhere: 2))
        #expect(NeedWords.position(tally) == "2 more in delegated work")
        #expect(NeedWords.spokenPosition(tally) == "2 more requests in delegated work")
    }

    @Test func severalHereAndSomeInDelegatedWorkSayBoth() {
        let tally = NeedTally(here: 2, elsewhere: 1)
        #expect(NeedWords.position(tally) == "1 of 2 here, 1 more in delegated work")
        #expect(NeedWords.spokenPosition(tally) == "1 of 2 requests here, 1 more request in delegated work")
    }

    @Test func aReadThatStoppedShortSaysHowManyItReadAndThatMoreWait() throws {
        let model = waiting()
        model.receive(try json([needs(total: 231, loaded: 200, more: true, elsewhere: 0, requests: [approval("ask-1")])]))
        let tally = model.needsTally("asking")
        #expect(tally == NeedTally(here: 200, more: true))
        #expect(NeedWords.position(tally) == "1 of 200 read, more waiting")
        #expect(NeedWords.spokenPosition(tally) == "1 of 200 requests read on this phone, more waiting")
    }

    @Test func requestsAllOnThisThreadSayOnlyWhereTheShownOneStands() throws {
        let model = waiting()
        model.receive(try json([needs(total: 3, loaded: 3, more: false, elsewhere: 0, requests: [approval("ask-1")])]))
        #expect(NeedWords.position(model.needsTally("asking")) == "1 of 3")
        #expect(NeedWords.spokenPosition(model.needsTally("asking")) == "1 of 3 requests")
        #expect(NeedWords.position(NeedTally(here: 1)) == nil)
    }

    @Test func anOlderBridgesRowWithoutReadCountsStillShows() throws {
        let model = waiting()
        var older = needs(total: 2, loaded: 0, more: false, elsewhere: 0, requests: [approval("ask-1")])
        for key in ["loaded", "more", "elsewhere"] { older.removeValue(forKey: key) }
        model.receive(try json([older]))
        #expect(model.needsYou("asking").map(\.id) == ["ask-1"])
        #expect(model.needsTally("asking") == NeedTally(here: 2))
    }

    @Test func aRequestTooLargeToSendIsCountedAndOffersOnlyOpen() throws {
        let model = waiting()
        let tooLarge: [String: Any] = [
            "id": "huge", "kind": "too_large", "state": "pending", "title": "A request too large to show here",
            "description": "Open it on your computer to see and answer it.", "command": "", "options": [],
            "truncated": true, "unanswerable": true,
        ]
        model.receive(try json([needs(total: 1, loaded: 1, more: false, elsewhere: 0, requests: [tooLarge])]))
        let request = try #require(model.needsYou("asking").first)
        #expect(model.needsTally("asking") == NeedTally(here: 1))
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
    private func needs(total: Int, loaded: Int, more: Bool, elsewhere: Int, requests: [[String: Any]]) -> [String: Any] {
        ["type": "inbox.needs", "id": "asking", "total": total, "loaded": loaded, "more": more, "elsewhere": elsewhere,
         "requests": requests]
    }
    private func approval(_ id: String) -> [String: Any] {
        ["id": id, "kind": "approval", "state": "pending", "title": "Run a command", "description": "",
         "command": "make \(id)", "truncated": false,
         "options": [["id": "\(id):allow", "label": "Allow once", "kind": "allow_once"]]]
    }
    private func json(_ patches: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: patches) }
}
