import Foundation
import Testing
@testable import Ace

/// The archive sheet's paging through the real ClientModel: a page is asked for only when the
/// bridge says there is one, at most one at a time, and closing hands the store back.
@Suite @MainActor struct ArchivePagingTests {
    @Test func opensThenPagesOneAtATimeUntilTheArchiveEnds() async throws {
        let (model, session) = try await connected()
        model.openArchive()
        #expect(session.archive.map { $0["kind"] as? String } == ["open"])
        // Nothing to page before the first list arrives.
        #expect(!model.loadMoreArchived())

        session.patch(list(ids: (0..<20).map { "a\($0)" }, more: true))
        try await until { model.archive.list.ids.count == 20 }
        #expect(model.archive.canLoadMore)
        #expect(model.loadMoreArchived())
        // A second tap while the page is on its way asks for nothing.
        #expect(!model.loadMoreArchived())
        #expect(session.archive.map { $0["kind"] as? String } == ["open", "more"])

        session.patch(list(ids: (0..<20).map { "a\($0)" }, more: true, loading: true))
        try await until { model.archive.list.loading }
        #expect(!model.loadMoreArchived())
        session.patch(list(ids: (0..<25).map { "a\($0)" }, more: false))
        try await until { model.archive.list.ids.count == 25 }
        #expect(!model.archive.loading)
        #expect(!model.loadMoreArchived())
        #expect(session.archive.count == 2)
    }

    @Test func aFailedPageCanBeRetried() async throws {
        let (model, session) = try await connected()
        model.openArchive()
        session.patch(list(ids: ["a"], more: true))
        try await until { model.archive.list.loaded }
        #expect(model.loadMoreArchived())
        session.patch(list(ids: ["a"], more: true, failed: true))
        try await until { model.archive.list.failed }
        #expect(model.loadMoreArchived())
        #expect(session.archive.filter { $0["kind"] as? String == "more" }.count == 2)
    }

    @Test func closingForgetsTheListAndReturnsToTheHomeWindow() async throws {
        let (model, session) = try await connected()
        model.openArchive()
        session.patch(list(ids: ["a", "b"], more: true))
        try await until { model.archive.list.ids.count == 2 }
        model.closeArchive()
        #expect(model.archive.list.ids.isEmpty)
        #expect(!model.archive.canLoadMore)
        #expect(session.archive.last?["kind"] as? String == "close")
    }

    @Test func anArchivedRowKeepsWhenItWasArchivedSoTheThreadOpensReadOnly() async throws {
        let (model, session) = try await connected()
        session.patch(#"{"type":"inbox.row","id":"old","row":{"id":"old","title":"Old","state":"done","attention":null,"project":"ace","branch":"","machine":"","provider":"codex","model":"","agents":1,"snoozedUntil":null,"updatedAt":1,"canSteer":false,"status":{"label":"Done","token":"done"},"machineId":"host","activityAt":1,"archivedAt":5}}"#)
        try await until { model.inbox["old"] != nil }
        #expect(model.error == nil, "\(model.error ?? "")")
        #expect(model.inbox["old"]?.archivedAt == 5)
    }

    // MARK: Helpers

    private func list(ids: [String], more: Bool, loading: Bool = false, failed: Bool = false) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [
            "type": "archive.list", "open": true, "ids": ids, "more": more, "loaded": true, "loading": loading, "failed": failed,
        ])
        return data.map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }
    private func connected() async throws -> (ClientModel, ArchiveSession) {
        let holder = SessionHolder()
        let model = ClientModel(now: { 0 }, makeRuntime: { _, _, receive, _ in holder.make(receive) })
        let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:1")), hostId: "host", deviceId: "device",
                                      pin: nil, credential: { "{}" })
        await model.connect(target: target, directory: FileManager.default.temporaryDirectory)
        return (model, try #require(holder.session))
    }
    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<500 where !condition() { await Task.yield() }
        #expect(condition())
    }
}

@MainActor private final class SessionHolder {
    var session: ArchiveSession?
    func make(_ receive: @escaping @Sendable (Data) -> Void) -> any ClientSession {
        let session = ArchiveSession(receive: receive)
        self.session = session
        return session
    }
}
private final class ArchiveSession: ClientSession, @unchecked Sendable {
    private let receive: @Sendable (Data) -> Void
    private let lock = NSLock()
    private var invoked: [[String: Any]] = []
    init(receive: @escaping @Sendable (Data) -> Void) { self.receive = receive }
    /// The archive actions the bridge was asked for, in order.
    var archive: [[String: Any]] {
        lock.withLock { invoked.filter { $0["type"] as? String == "archive" }.compactMap { $0["action"] as? [String: Any] } }
    }
    func start(itemLimit: Int) {}
    func invoke(_ name: String, json: String) {
        guard let value = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return }
        lock.withLock { invoked.append(value) }
    }
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { completion() }
    func patch(_ json: String) { receive(Data("[\(json)]".utf8)) }
}
