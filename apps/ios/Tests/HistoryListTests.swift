import Foundation
import Testing
@testable import Ace

/// History's reads across machines: older threads page in once per machine and query however
/// often the read restarts, a disconnected machine's threads stay, and a machine that never
/// connects turns into a failure after the wait, on the injected clock.
@Suite @MainActor struct HistoryListTests {
    @Test func olderThreadsPageInOncePerMachineAndQueryThoughTheReadRestarts() async throws {
        let (inbox, sessions, models) = try await machines(["studio"])
        defer { models.forEach { $0.disconnect() } }
        let session = try #require(sessions.first)
        let history = HistoryList(sleep: { _ in })
        // The first read asks for older pages; it is cancelled before its answer, as when the
        // pages' arrival moves the revision and restarts the read.
        let first = Task { await history.run(inbox, query: "relay") }
        try await wait { session.requests.count == 1 }
        #expect(session.older(at: 0) == true)
        first.cancel()
        let restarted = Task { await history.run(inbox, query: "relay") }
        try await wait { session.requests.count == 2 }
        #expect(session.older(at: 1) == false)
        try session.answer(at: 1, threads: ["a"])
        await restarted.value
        // Read again after an answer: still no more paging for this query.
        let again = Task { await history.run(inbox, query: "relay") }
        try await wait { session.requests.count == 3 }
        #expect(session.older(at: 2) == false)
        try session.answer(at: 2, threads: ["a"])
        await again.value
        // A new query may page again.
        let other = Task { await history.run(inbox, query: "notes") }
        try await wait { session.requests.count == 4 }
        #expect(session.older(at: 3) == true)
        other.cancel()
    }

    @Test func aDisconnectedMachineKeepsItsThreadsWhileTheOtherAnswers() async throws {
        let (inbox, sessions, models) = try await machines(["studio", "laptop"])
        defer { models.forEach { $0.disconnect() } }
        let history = HistoryList(sleep: { _ in })
        let first = Task { await history.run(inbox, query: "") }
        try await wait { sessions.allSatisfy { $0.requests.count == 1 } }
        try sessions[0].answer(at: 0, threads: ["s1"])
        try sessions[1].answer(at: 0, threads: ["l1"])
        await first.value
        #expect(Set(history.answers.keys) == ["studio", "laptop"])

        models[1].connection = "offline"
        let second = Task { await history.run(inbox, query: "") }
        try await wait { sessions[0].requests.count == 2 }
        try sessions[0].answer(at: 1, threads: ["s1", "s2"])
        await second.value
        #expect(Set(history.answers.keys) == ["studio", "laptop"])
        #expect(history.answers["laptop"]?.threads.map(\.id) == ["l1"])
        #expect(history.phase == .ready)

        // With neither connected, what each said to this query still shows.
        models[0].connection = "offline"
        await history.run(inbox, query: "")
        #expect(Set(history.answers.keys) == ["studio", "laptop"])
        #expect(history.phase == .ready)
    }

    @Test func aMachineThatNeverConnectsBecomesAFailureAfterTheWait() async throws {
        let inbox = MachineInbox(defaults: try suite(), now: { 0 })
        let client = ClientModel(now: { 0 })
        client.connection = "connecting"
        inbox.attach("studio", name: "Studio", client: client)
        let gate = SleepGate()
        let history = HistoryList(patience: .seconds(10), sleep: { duration in
            await gate.sleep(duration)
            try Task.checkCancellation()
        })
        let read = Task { await history.run(inbox, query: "") }
        try await wait { await gate.waiting == [.seconds(10)] }
        #expect(history.phase == .loading)
        await gate.open()
        await read.value
        #expect(history.phase == .failed)
    }

    @Test func aWaitCancelledByANewerReadLeavesHistoryLoading() async throws {
        let inbox = MachineInbox(defaults: try suite(), now: { 0 })
        let client = ClientModel(now: { 0 })
        client.connection = "starting"
        inbox.attach("studio", name: "Studio", client: client)
        let gate = SleepGate()
        let history = HistoryList(patience: .seconds(10), sleep: { duration in
            await gate.sleep(duration)
            try Task.checkCancellation()
        })
        let read = Task { await history.run(inbox, query: "") }
        try await wait { await gate.waiting.count == 1 }
        read.cancel()
        await gate.open()
        await read.value
        #expect(history.phase == .loading)
    }

    // MARK: Helpers

    private func machines(_ hosts: [String]) async throws -> (MachineInbox, [HistorySession], [ClientModel]) {
        let inbox = MachineInbox(defaults: try suite(), now: { 0 })
        var sessions: [HistorySession] = []
        var models: [ClientModel] = []
        for host in hosts {
            let session = HistorySession()
            let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: { _, _, _, _ in session })
            session.reply = { data in model.receive(data) }
            await model.connect(target: ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:1")), hostId: host,
                                                         deviceId: "phone", pin: nil, credential: { "{}" }),
                                directory: FileManager.default.temporaryDirectory)
            model.connection = "ready"
            inbox.attach(host, name: host, client: model)
            sessions.append(session)
            models.append(model)
        }
        return (inbox, sessions, models)
    }
    private func suite() throws -> UserDefaults {
        let name = "history-list-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defaults.removePersistentDomain(forName: name)
        return defaults
    }
    private func wait(_ ready: () async -> Bool) async throws {
        for _ in 0..<400 {
            if await ready() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("History's read never got there")
    }
}

/// A sleep the test ends: it records how long each was asked for and returns when opened.
private actor SleepGate {
    private(set) var waiting: [Duration] = []
    private var held: [CheckedContinuation<Void, Never>] = []
    func sleep(_ duration: Duration) async {
        waiting.append(duration)
        await withCheckedContinuation { held.append($0) }
    }
    func open() {
        for continuation in held { continuation.resume() }
        held = []
    }
}

/// A machine's runtime that records History's service requests and answers them on cue.
private final class HistorySession: ClientSession, @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [[String: Any]] = []
    var reply: (@MainActor (Data) -> Bool)?
    var requests: [[String: Any]] {
        lock.withLock { pending.filter { ($0["request"] as? [String: Any])?["type"] as? String == "history.query" } }
    }
    func start(itemLimit: Int) {}
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { completion() }
    func invoke(_ name: String, json: String) {
        guard let data = json.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["type"] as? String == "service" else { return }
        lock.withLock { pending.append(value) }
    }
    func older(at index: Int) -> Bool? { (requests[index]["request"] as? [String: Any])?["older"] as? Bool }
    @MainActor func answer(at index: Int, threads: [String]) throws {
        let id = try #require(requests[index]["id"] as? String)
        let rows: [[String: Any]] = threads.enumerated().map { offset, thread in
            ["id": thread, "title": thread, "project": "ace", "workspaceId": "ace", "at": Double(100 - offset),
             "group": "week", "label": "This week", "date": "1d", "listed": true]
        }
        let data = try JSONSerialization.data(withJSONObject: [["type": "service.reply", "id": id, "ok": true, "message": "",
                                                                "value": ["threads": rows]]])
        #expect(reply?(data) == true)
    }
}
