import Foundation
import Testing
@testable import Ace

@Suite @MainActor struct ConversationSearchTests {
    @Test func aLateSearchCannotReplaceTheNewerQueryOrAppendItsPages() async throws {
        let session = SearchSession()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { _, _, _, _ in session })
        session.reply = { data in model.receive(data) }
        await model.connect(target: ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:1")), hostId: "host", deviceId: "phone", pin: nil, credential: { "{}" }), directory: FileManager.default.temporaryDirectory)
        model.connection = "ready"
        defer { model.disconnect() }
        let search = ConversationSearch()
        let old = Task { await search.search(model: model, text: "old", kind: "", threadId: nil) }
        try await wait { session.requests.count == 1 }
        let newer = Task { await search.search(model: model, text: "new", kind: "", threadId: nil) }
        try await wait { session.requests.count == 2 }
        try session.answer(at: 1, text: "New result", cursor: "new-page")
        await newer.value
        #expect(search.hits.map(\.threadTitle) == ["New result"])
        try session.answer(at: 0, text: "Old result", cursor: "old-page")
        await old.value
        #expect(search.hits.map(\.threadTitle) == ["New result"])
        #expect(search.cursor == "new-page")
        let more = Task { await search.more(model: model, text: "new", kind: "", threadId: nil) }
        try await wait { session.requests.count == 3 }
        await search.search(model: model, text: "", kind: "", threadId: nil)
        try session.answer(at: 2, text: "Obsolete page", cursor: nil)
        await more.value
        #expect(search.hits.isEmpty && search.cursor == nil && !search.loading)
    }
    @Test func aRefusedCursorOffersARefreshWithoutErasingResults() async throws {
        let session = SearchSession()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { _, _, _, _ in session })
        session.reply = { data in model.receive(data) }
        await model.connect(target: ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:1")), hostId: "host", deviceId: "phone", pin: nil, credential: { "{}" }), directory: FileManager.default.temporaryDirectory)
        model.connection = "ready"
        defer { model.disconnect() }
        let search = ConversationSearch()
        let first = Task { await search.search(model: model, text: "find", kind: "message", threadId: "thread") }
        try await wait { session.requests.count == 1 }
        try session.answer(at: 0, text: "Keep this result", cursor: "page")
        await first.value
        let more = Task { await search.more(model: model, text: "find", kind: "message", threadId: "thread") }
        try await wait { session.requests.count == 2 }
        try session.answerError(at: 1)
        await more.value
        #expect(search.hits.map(\.threadTitle) == ["Keep this result"])
        #expect(search.problem?.contains("index changed") == true && !search.loading)
    }
    private func wait(_ ready: () -> Bool) async throws {
        for _ in 0..<200 {
            if ready() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("No search request arrived")
    }
}

private final class SearchSession: ClientSession, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [[String: Any]] = []
    var reply: (@MainActor (Data) -> Bool)?
    var requests: [[String: Any]] { lock.withLock { pending } }
    func start(itemLimit: Int) {}
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { completion() }
    func invoke(_ name: String, json: String) {
        guard let data = json.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any], value["type"] as? String == "service" else { return }
        lock.withLock { pending.append(value) }
    }
    @MainActor func answer(at index: Int, text: String, cursor: String?) throws {
        let id = try #require(requests[index]["id"] as? String)
        let hit: [String: Any] = ["threadId": "thread", "threadTitle": text, "itemId": "message", "kind": "message", "provider": "codex", "createdAt": 0, "title": ["text": text], "snippet": ["text": text]]
        let data = try JSONSerialization.data(withJSONObject: [["type": "service.reply", "id": id, "ok": true, "message": "", "value": ["type": "search.results", "hits": [hit], "cursor": cursor.map { $0 as Any } ?? NSNull()]]])
        #expect(reply?(data) == true)
    }
    @MainActor func answerError(at index: Int) throws {
        let id = try #require(requests[index]["id"] as? String)
        #expect(reply?(try JSONSerialization.data(withJSONObject: [["type": "service.reply", "id": id, "ok": true, "message": "", "value": ["type": "search.error", "code": "search_cursor_stale"]]])) == true)
    }
}
