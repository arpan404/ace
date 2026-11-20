import Foundation
import Testing
@testable import Ace

@Suite @MainActor struct ConnectionLifecycleTests {
    @Test func replacingAConnectionWaitsForShutdownAndIgnoresItsLateUpdates() async throws {
        let sessions = Sessions()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await model.connect(target: try target("first"), directory: directory)
        let first = try #require(sessions.values.first)
        first.emit("ready")
        // Frames decode on their own queue, then apply on the main actor: wait for the state.
        await settle { model.connection == "ready" }
        #expect(model.connection == "ready")
        model.open("old-thread")
        model.inboxLoaded = true

        let replacement = Task { await model.connect(target: try target("second"), directory: directory) }
        await drain()
        #expect(model.connection == "connecting")
        #expect(model.thread == nil)
        #expect(!model.inboxLoaded)
        first.emit("offline")
        first.fail("Old runtime failure")
        await drain()
        #expect(model.connection == "connecting")
        #expect(model.error == nil)
        // The new host cannot produce visible facts before the old VM releases storage.
        first.finishShutdown()
        try await replacement.value
        let second = try #require(sessions.values.last)
        second.emit("ready")
        first.emit("offline")
        first.fail("Late old failure")
        await settle { model.connection == "ready" }
        // The retired runtime's late updates had their chance to land too; none may show.
        await drain()
        #expect(model.connection == "ready")
        #expect(model.error == "second")
        model.disconnect()
        await drain()
        second.finishShutdown()
        await model.disconnectAndWait()
    }

    /// Opening a thread sends its window over several frames, each sent once the one before is
    /// acknowledged. A busy main thread (laying out the screen being pushed) must not hold that
    /// back: a frame it can't turn down is acknowledged as soon as it is decoded, and applies in
    /// arrival order once the main thread is free. A streaming text edit, checked against the
    /// text on screen, still waits for the main thread.
    @Test func framesAreAcknowledgedWhileTheMainThreadIsBusyAndApplyInOrder() async throws {
        let sessions = Sessions()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await model.connect(target: try target("first"), directory: directory)
        let session = try #require(sessions.values.first)
        session.emit("connecting")
        session.emit("ready")
        session.receive(Data(#"[{"type":"thread.item.text","threadId":"t","epoch":1,"id":"a","base":0,"cut":0,"append":"x"}]"#.utf8))
        // The main thread stays busy here: nothing it runs can acknowledge a frame meanwhile.
        busy(until: { session.acks.count >= 2 })
        #expect(session.acks == [true, true])
        #expect(model.connection != "ready")
        // Free again, it applies them in the order they came, then answers the text edit.
        await settle { model.connection == "ready" && session.acks.count == 3 }
        #expect(model.connection == "ready")
        #expect(session.acks == [true, true, true])
        model.disconnect()
        await drain()
        session.finishShutdown()
        await model.disconnectAndWait()
    }

    @Test func disconnectCancelsAReplacementWaitingForThePreviousRuntime() async throws {
        let sessions = Sessions()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await model.connect(target: try target("first"), directory: directory)
        let first = try #require(sessions.values.first)
        let replacement = Task { await model.connect(target: try target("second"), directory: directory) }
        await drain()
        model.disconnect()
        first.finishShutdown()
        try await replacement.value
        // A disconnected model rejects sends and ignores all retired callbacks.
        model.open("thread")
        #expect(await model.send("Keep this draft", delivery: "queue") == false)
        first.fail("Retired")
        await drain()
        #expect(model.error != "Retired")
        await model.disconnectAndWait()
    }

    @Test func theLatestConnectionWinsWhenSeveralWaitForShutdown() async throws {
        let sessions = Sessions()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await model.connect(target: try target("first"), directory: directory)
        let first = try #require(sessions.values.first)
        let second = Task { await model.connect(target: try target("second"), directory: directory) }
        await drain()
        let third = Task { await model.connect(target: try target("third"), directory: directory) }
        await drain()
        first.finishShutdown()
        try await second.value
        try await third.value
        await drain()
        // Every started session reports its host as a visible error for this boundary test.
        #expect(model.error == "third")
        model.disconnect()
        await drain()
        sessions.values.last?.finishShutdown()
        await model.disconnectAndWait()
    }

    @Test(.timeLimit(.minutes(1))) func disconnectDuringVMStartupCompletesAndRetiredCallbacksStayInvisible() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let model = ClientModel(now: { 0 })
        for _ in 0..<3 {
            await model.connect(target: try target("ios-spike-host"), directory: root)
            await model.disconnectAndWait()
        }
        await drain()
        #expect(model.connection == "connecting")
        #expect(model.inbox.isEmpty)
        #expect(model.error == nil)
    }

    @Test func aRouteChangeToTheSameMachineKeepsTheOpenThreadOnScreenAndReopensItThere() async throws {
        let sessions = Sessions()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await model.connect(target: try target("mac", port: SpikeFixture.port), directory: directory)
        let direct = try #require(sessions.values.first)
        direct.emit("ready")
        await drain()
        model.open("thread")
        let first = try #require(model.thread?.epoch)
        model.receive(try frame([reset(first), item("kept", epoch: first), ready(first)]))
        let shown = try #require(model.thread)
        #expect(shown.loaded)

        // The same machine over another route (direct to relay): the page never empties.
        let relay = Task { await model.connect(target: try target("mac", port: SpikeFixture.port + 1), directory: directory) }
        await drain()
        #expect(model.thread === shown)
        #expect(shown.order == ["kept"])
        direct.finishShutdown()
        try await relay.value
        let replacement = try #require(sessions.values.last)
        #expect(replacement !== direct)
        // The new route's runtime never saw this thread, so it is asked for it whole.
        let open = try #require(replacement.actions.last { $0["type"] as? String == "open" })
        #expect(open["threadId"] as? String == "thread")
        #expect(open["warm"] as? Bool == false)

        // Its cold reset stages behind the kept copy; only the matching fence replaces it.
        let second = try #require(model.thread?.epoch)
        model.receive(try frame([reset(second), item("fresh", epoch: second)]))
        #expect(model.thread === shown)
        #expect(shown.order == ["kept"])
        #expect(shown.loaded)
        model.receive(try frame([ready(second)]))
        #expect(shown.order == ["fresh"])
        model.disconnect()
        await drain()
        replacement.finishShutdown()
        await model.disconnectAndWait()
    }

    @Test func aRouteChangeKeepsTheTypedReviewReplyAndAnswersItsUnansweredSend() async throws {
        let sessions = Sessions()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await model.connect(target: try target("mac", port: SpikeFixture.port), directory: directory)
        let direct = try #require(sessions.values.first)
        direct.emit("ready")
        await settle { model.connection == "ready" }
        model.open("thread")
        model.sheets.replyTexts["comment-1"] = "Half-typed reply"
        model.sheets.sent("reply-1")

        // Direct to relay on the same machine: the thread stays open, and so does the reply.
        let relay = Task { await model.connect(target: try target("mac", port: SpikeFixture.port + 1), directory: directory) }
        await drain()
        direct.finishShutdown()
        try await relay.value
        #expect(model.sheets.replyTexts["comment-1"] == "Half-typed reply")
        // The retired route can't answer the send, so it reads as uncertain instead of Sending….
        let notice = try #require(model.sheets.notices["reply-1"])
        #expect(!notice.ok)

        // Another machine: nothing typed for this one's comments carries over.
        let other = Task { await model.connect(target: try target("other"), directory: directory) }
        await drain()
        sessions.values.last?.finishShutdown()
        try await other.value
        #expect(model.sheets.replyTexts.isEmpty)
        #expect(model.sheets.notices.isEmpty)
        model.disconnect()
        await drain()
        sessions.values.last?.finishShutdown()
        await model.disconnectAndWait()
    }

    private var directory: URL { URL(fileURLWithPath: "/unused-lifecycle-contract") }
    private func target(_ host: String, port: Int = SpikeFixture.port) throws -> ConnectionTarget {
        ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:\(port)")),
                         hostId: host, deviceId: "phone", pin: nil, credential: { "{}" })
    }
    private func reset(_ epoch: Int) -> [String: Any] {
        ["type": "thread.reset", "threadId": "thread", "epoch": epoch, "revision": 1]
    }
    private func ready(_ epoch: Int) -> [String: Any] {
        ["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": 1, "revision": 1]
    }
    private func item(_ id: String, epoch: Int) -> [String: Any] {
        let row: [String: Any] = ["id": id, "index": 0, "type": "message", "role": "user", "text": id,
                                  "complete": true, "createdAt": 0, "agentId": "root", "truncated": false]
        return ["type": "thread.item", "threadId": "thread", "epoch": epoch, "id": id, "row": row]
    }
    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
    /// Keeps the main thread busy, as a long layout does, until `done` or five seconds.
    private func busy(until done: () -> Bool) {
        let deadline = Date().addingTimeInterval(5)
        while !done(), Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
    }
    private func drain() async { for _ in 0..<20 { await Task.yield() } }
    /// Until `done`, for at most a second: what crosses the decoder's queue lands in its own time.
    private func settle(_ done: () -> Bool) async {
        for _ in 0..<500 where !done() { try? await Task.sleep(for: .milliseconds(2)) }
    }
}

/// Only the uncontrolled VM/shutdown boundary is substituted. Model state uses its real decoder.
@MainActor private final class Sessions {
    var values: [Session] = []
    func make(_ target: ConnectionTarget, _ storage: URL,
              _ receive: @escaping @Sendable (Data) -> Void,
              _ fail: @escaping @Sendable (String) -> Void) -> any ClientSession {
        let session = Session(host: target.hostId, receive: receive, fail: fail)
        values.append(session)
        return session
    }
}
private final class Session: ClientSession, @unchecked Sendable {
    let host: String
    let receive: @Sendable (Data) -> Void
    let fail: @Sendable (String) -> Void
    private var stopped: (@Sendable () -> Void)?
    private let lock = NSLock()
    init(host: String, receive: @escaping @Sendable (Data) -> Void, fail: @escaping @Sendable (String) -> Void) {
        self.host = host; self.receive = receive; self.fail = fail
    }
    func start(itemLimit: Int) { fail(host) }
    /// The bridge actions this runtime was sent, in order.
    var actions: [[String: Any]] { lock.withLock { sent } }
    private var sent: [[String: Any]] = []
    func invoke(_ name: String, json: String) {
        guard let value = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return }
        lock.withLock { sent.append(value) }
    }
    /// Each frame's acknowledgement, in the order the model gave them.
    var acks: [Bool] { lock.withLock { acknowledged } }
    private var acknowledged: [Bool] = []
    func acknowledge(accepted: Bool) { lock.withLock { acknowledged.append(accepted) } }
    func stop(completion: @escaping @Sendable () -> Void) { lock.withLock { stopped = completion } }
    func finishShutdown() {
        let completion = lock.withLock { let result = stopped; stopped = nil; return result }
        completion?()
    }
    func emit(_ state: String) { receive(Data("[{\"type\":\"connection\",\"state\":\"\(state)\"}]".utf8)) }
}
