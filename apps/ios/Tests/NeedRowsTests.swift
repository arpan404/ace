import Foundation
import Testing
@testable import Ace

/// A needs-you row as the bridge publishes it (`inbox-needs.ts`): the line counts the requests
/// on this thread it can show, says apart how many wait in the thread's delegated work, says when
/// the phone's read stopped before finding them all, and only a whole approval answers from the
/// row itself.
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

    @Test func aRequestTooLargeToSendIsCountedAndOffersNoAnswerFromItsRow() throws {
        let model = waiting()
        let tooLarge: [String: Any] = [
            "id": "huge", "kind": "too_large", "state": "pending", "title": "A request too large to show here",
            "description": "Open it on your computer to see and answer it.", "command": "", "options": [],
            "truncated": true, "unanswerable": true,
        ]
        model.receive(try json([needs(total: 1, loaded: 1, more: false, elsewhere: 0, requests: [tooLarge])]))
        let request = try #require(model.needsYou("asking").first)
        #expect(model.needsTally("asking") == NeedTally(here: 1))
        // Answered on a computer: the row opens its thread and offers no answer of its own.
        #expect(NeedActions(request: request, model: model, threadId: "asking", decided: {}).answers.isEmpty)
    }

    @Test func aWaitingApprovalAnswersFromItsRowWithDenyAndAllowOnce() throws {
        let model = waiting()
        var ask = approval("ask-1")
        ask["options"] = [["id": "ask-1:deny", "label": "Deny", "kind": "deny"], ["id": "ask-1:allow", "label": "Allow once", "kind": "allow_once"]]
        model.receive(try json([needs(total: 1, loaded: 1, more: false, elsewhere: 0, requests: [ask])]))
        let request = try #require(model.needsYou("asking").first)
        let actions = NeedActions(request: request, model: model, threadId: "asking", decided: {})
        // What the row's swipes, long-press menu and VoiceOver actions offer.
        #expect(actions.answers.map(\.label) == ["Allow once", "Deny"])
    }

    @Test func aRequestThatNeedsMoreThanAllowOrDenyOffersNoAnswerFromItsRow() throws {
        let model = waiting()
        let question: [String: Any] = [
            "id": "scope", "kind": "question", "state": "pending", "title": "Scope", "description": "", "command": "",
            "truncated": false, "options": [],
        ]
        model.receive(try json([needs(total: 1, loaded: 1, more: false, elsewhere: 0, requests: [question])]))
        let request = try #require(model.needsYou("asking").first)
        let actions = NeedActions(request: request, model: model, threadId: "asking", decided: {})
        #expect(actions.answers.isEmpty)
    }

    @Test func anApprovalOnItsWayOrOnAViewOnlyPhoneOffersNoAnswerFromItsRow() throws {
        let model = waiting()
        model.receive(try json([needs(total: 1, loaded: 1, more: false, elsewhere: 0, requests: [approval("ask-1")])]))
        let request = try #require(model.needsYou("asking").first)
        let actions = NeedActions(request: request, model: model, threadId: "asking", decided: {})
        #expect(actions.answers.map(\.label) == ["Allow once"])
        model.approvalSubmissions["ask-1"] = ApprovalSubmission(requestId: "r-1", phase: .waiting)
        #expect(actions.answers.isEmpty)
        model.approvalSubmissions["ask-1"] = nil
        model.canOperate = false
        #expect(actions.answers.isEmpty)
    }

    @Test func allowOnceAndDenySendTheirOwnOptionForTheRequestTheRowShowsNow() async throws {
        let (model, session) = try await connected()
        model.receive(try json([needs(total: 1, loaded: 1, more: false, elsewhere: 0, requests: [ask("ask-1")])]))
        // The agent withdrew its request and asked another: the row reads the new one.
        model.receive(try json([needs(total: 1, loaded: 1, more: false, elsewhere: 0, requests: [ask("ask-2")])]))
        try answer("allow_once", on: model)
        #expect(session.answers == [Sent(interaction: "ask-2", option: "ask-2:allow")])

        model.receive(try json([needs(total: 1, loaded: 1, more: false, elsewhere: 0, requests: [ask("ask-3")])]))
        try answer("deny", on: model)
        #expect(session.answers.last == Sent(interaction: "ask-3", option: "ask-3:deny"))
    }

    @Test func aSecondAnswerWhileTheFirstIsOnItsWaySendsNothing() async throws {
        let (model, session) = try await connected()
        model.receive(try json([needs(total: 1, loaded: 1, more: false, elsewhere: 0, requests: [ask("ask-1")])]))
        let request = try #require(model.needsYou("asking").first)
        // The words the row drew before the first answer left, activated again (a double tap, a
        // swipe then the menu): the first answer stands alone.
        let shown = NeedActions(request: request, model: model, threadId: "asking", decided: {}).answers
        for id in ["allow_once", "allow_once", "deny"] { shown.first { $0.id == id }?.run() }
        #expect(session.answers == [Sent(interaction: "ask-1", option: "ask-1:allow")])
        #expect(NeedActions(request: request, model: model, threadId: "asking", decided: {}).answers.isEmpty)
    }

    /// Runs one of the row's answers as the row builds them now, from the request it shows.
    private func answer(_ id: String, on model: ClientModel) throws {
        let request = try #require(model.needsYou("asking").first)
        let word = try #require(NeedActions(request: request, model: model, threadId: "asking", decided: {}).answers.first { $0.id == id })
        word.run()
    }
    /// An approval offering Deny and Allow once.
    private func ask(_ id: String) -> [String: Any] {
        var request = approval(id)
        request["options"] = [["id": "\(id):deny", "label": "Deny", "kind": "deny"], ["id": "\(id):allow", "label": "Allow once", "kind": "allow_once"]]
        return request
    }
    /// A connected model, its inbox listing the asking thread, and the session it sends through.
    private func connected() async throws -> (ClientModel, NeedsSession) {
        let holder = NeedsSessionHolder()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { _, _, receive, _ in holder.make(receive) })
        let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:1")), hostId: "host", deviceId: "device",
                                      pin: nil, credential: { "{}" })
        await model.connect(target: target, directory: FileManager.default.temporaryDirectory)
        model.receive(try json(rowPatches()))
        return (model, try #require(holder.session))
    }

    /// A model whose inbox lists the asking thread as needing the person.
    private func waiting() -> ClientModel {
        let model = ClientModel(now: { 0 })
        model.receive(try! json(rowPatches()))
        return model
    }
    private func rowPatches() -> [[String: Any]] {
        [
            ["type": "inbox.reset", "ids": ["asking"]],
            ["type": "inbox.row", "id": "asking", "row": [
                "id": "asking", "title": "asking", "state": "needs_you", "project": "ace", "branch": "", "machine": "",
                "provider": "codex", "model": "", "agents": 1, "updatedAt": 1, "canSteer": false,
                "status": ["label": "Approve", "token": "needsYou"], "confirmed": true, "generation": 0,
            ] as [String: Any]],
        ]
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

/// An answer the model handed the bridge: the request it answers and the option picked.
private struct Sent: Equatable { let interaction: String; let option: String }

@MainActor private final class NeedsSessionHolder {
    var session: NeedsSession?
    func make(_ receive: @escaping @Sendable (Data) -> Void) -> any ClientSession {
        let session = NeedsSession()
        self.session = session
        return session
    }
}
/// Keeps the actions the model sends; answers nothing.
private final class NeedsSession: ClientSession, @unchecked Sendable {
    private let lock = NSLock()
    private var invoked: [[String: Any]] = []
    /// The approvals answered, in order.
    var answers: [Sent] {
        lock.withLock {
            invoked.filter { $0["type"] as? String == "needs.answer" }.compactMap { action in
                guard let interaction = action["interactionId"] as? String,
                      let option = (action["answer"] as? [String: Any])?["optionId"] as? String else { return nil }
                return Sent(interaction: interaction, option: option)
            }
        }
    }
    func start(itemLimit: Int) {}
    func invoke(_ name: String, json: String) {
        guard let value = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return }
        lock.withLock { invoked.append(value) }
    }
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { completion() }
}
