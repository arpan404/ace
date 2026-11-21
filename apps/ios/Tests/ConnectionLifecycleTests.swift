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
    /// back: a frame of the open thread's rows is acknowledged as soon as it is decoded, and the
    /// rows apply in arrival order once the main thread is free. A streaming text edit, checked
    /// against the text on screen, still waits for the main thread.
    @Test func theOpenThreadsFramesAreAcknowledgedWhileTheMainThreadIsBusyAndApplyInOrder() async throws {
        let (model, session) = try await connected()
        model.open("t")
        let epoch = try #require(model.thread?.epoch)
        session.send([item(epoch, "a", "First", index: 0)])
        session.send([item(epoch, "b", "Second", index: 1)])
        session.send([["type": "thread.item.text", "threadId": "t", "epoch": epoch, "id": "a", "base": 5, "cut": 0, "append": "!"]])
        // The main thread stays busy here: nothing it runs can acknowledge a frame meanwhile.
        busy(until: { session.acks.count >= 2 })
        #expect(session.acks == [true, true])
        #expect(model.thread?.items.isEmpty == true)
        // Free again, it applies them in the order they came, then answers the text edit.
        await settle { session.acks.count == 3 && model.thread?.items["a"]?.row.text == "First!" }
        #expect(session.acks == [true, true, true])
        #expect(model.thread?.order == ["a", "b"])
        await close(model, session)
    }

    /// A frame acknowledged before the main thread saw it counts, for the bridge, as shown: one
    /// for a thread the person has just left would be dropped once it applied, and the bridge
    /// would never send it again on a warm reopen. Such a frame waits for the main thread.
    @Test func aFrameForAThreadNoLongerOpenWaitsForTheMainThreadBeforeItIsAcknowledged() async throws {
        let (model, session) = try await connected()
        model.open("t")
        let epoch = try #require(model.thread?.epoch)
        model.back()
        session.send([item(epoch, "late", "Approved", index: 0)])
        busy(until: { !session.acks.isEmpty }, for: 0.5)
        #expect(session.acks.isEmpty)
        await settle { session.acks.count == 1 }
        #expect(session.acks == [true])
        await close(model, session)
    }

    /// A frame acknowledged early is applied before the person navigates: leaving the thread
    /// first takes every decoded frame, so the kept thread shows what the bridge believes it does.
    @Test func leavingAThreadAppliesEveryFrameAlreadyAcknowledgedForIt() async throws {
        let (model, session) = try await connected()
        model.open("t")
        let left = try #require(model.thread)
        session.send([item(left.epoch, "a", "Approved", index: 0)])
        busy(until: { session.acks.count >= 1 })
        #expect(session.acks == [true])
        model.back()
        #expect(model.thread == nil)
        #expect(left.items["a"]?.row.text == "Approved")
        await close(model, session)
    }

    /// A retired runtime's late frame never applies, even when a later open takes what is waiting.
    @Test func aRetiredRuntimesLateFrameNeverApplies() async throws {
        let (model, session) = try await connected()
        model.disconnect()
        session.emit("offline")
        busy(until: { false }, for: 0.3)
        model.open("t")
        await drain()
        #expect(model.connection == "ready")
        session.finishShutdown()
        await model.disconnectAndWait()
    }

    /// Retiring a runtime applies only what it already acknowledged: the bridge counts those as
    /// shown. A frame still waiting for the main thread, such as a relay saying it is
    /// reconnecting just as a direct route replaces it, is the retired runtime's last word and is
    /// dropped: read after the switch, it would make the new route look as if it had failed.
    @Test func retiringARuntimeAppliesOnlyTheFramesItAlreadyAcknowledged() async throws {
        let (model, session) = try await connected()
        model.open("t")
        let epoch = try #require(model.thread?.epoch)
        session.send([item(epoch, "a", "Shown", index: 0)])
        session.emit("reconnecting")
        // Both decode while the main thread is busy; only the open thread's row is answered.
        busy(until: { session.acks.count >= 1 }, for: 2)
        busy(until: { false }, for: 0.3)
        #expect(session.acks == [true])
        let shown = try #require(model.thread)
        model.disconnect()
        await drain()
        #expect(shown.items["a"]?.row.text == "Shown")
        #expect(model.connection == "ready")
        #expect(session.acks == [true])
        session.finishShutdown()
        await model.disconnectAndWait()
    }

    /// Acknowledging early must not let a busy main thread fall behind without bound: past the
    /// cap, frames wait for the main thread to take what is held, then flow again.
    @Test func earlyAcknowledgementsStopAtTheCapAndResumeAsTheMainThreadDrains() async throws {
        let (model, session) = try await connected()
        model.open("t")
        let epoch = try #require(model.thread?.epoch)
        let text = String(repeating: "x", count: 30_000)
        let frames = FrameIntake.answeredLimit / 30_000 + 8
        for index in 0..<frames { session.send([item(epoch, "r\(index)", text, index: index)]) }
        busy(until: { session.acks.count >= frames }, for: 2)
        #expect(session.acks.count < frames)
        #expect(session.acks.count > 1)
        await settle { session.acks.count == frames }
        #expect(session.acks.count == frames)
        #expect(model.thread?.order.count == frames)
        await close(model, session)
    }

    private func connected() async throws -> (ClientModel, Session) {
        let sessions = Sessions()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await model.connect(target: try target("first"), directory: directory)
        let session = try #require(sessions.values.first)
        session.emit("ready")
        await settle { model.connection == "ready" }
        _ = session.takeAcks()
        return (model, session)
    }
    private func close(_ model: ClientModel, _ session: Session) async {
        model.disconnect()
        await drain()
        session.finishShutdown()
        await model.disconnectAndWait()
    }
    private func item(_ epoch: Int, _ id: String, _ text: String, index: Int) -> [String: Any] {
        ["type": "thread.item", "threadId": "t", "epoch": epoch, "id": id,
         "row": ["id": id, "index": index, "type": "message", "role": "assistant", "text": text, "complete": true,
                 "createdAt": 0, "agentId": "", "truncated": false, "detail": "", "quiet": false] as [String: Any]]
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

    /// The new route's runtime opens the thread from a screenful (its tail), then sends the rest of
    /// its window once native says that screenful is drawn. A thread already on screen never
    /// shows the tail: its rows stay until the whole window replaces them, and the bridge is told
    /// at once that nothing waits to be drawn, so that window comes now.
    @Test func aRouteChangesTailNeverReplacesTheRowsOnScreenAndTheWholeWindowFollowsAtOnce() async throws {
        let sessions = Sessions()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await model.connect(target: try target("mac", port: SpikeFixture.port), directory: directory)
        let direct = try #require(sessions.values.first)
        direct.emit("ready")
        await drain()
        model.open("thread")
        let first = try #require(model.thread?.epoch)
        model.receive(try frame([reset(first), row("a", 0, first), row("b", 1, first), row("c", 2, first),
                                 ready(first, count: 3, revision: 1)]))
        let shown = try #require(model.thread)
        #expect(shown.order == ["a", "b", "c"])

        let relay = Task { await model.connect(target: try target("mac", port: SpikeFixture.port + 1), directory: directory) }
        await drain()
        direct.finishShutdown()
        try await relay.value
        let replacement = try #require(sessions.values.last)
        let second = try #require(model.thread?.epoch)

        // The tail: the newest row alone, fenced as a tail.
        model.receive(try frame([["type": "thread.reset", "threadId": "thread", "epoch": second, "revision": 2],
                                 row("c", 0, second), ready(second, count: 1, revision: 2, tail: true)]))
        #expect(model.thread === shown)
        #expect(shown.order == ["a", "b", "c"])
        #expect(shown.loaded)
        let told = replacement.actions.filter { $0["type"] as? String == "thread.shown" }
        #expect(told.count == 1)
        #expect(told.first?["epoch"] as? Int == second)

        // The whole window carries on from the tail, as the bridge's ledger holds it.
        model.receive(try frame([["type": "thread.snapshot.begin", "threadId": "thread", "epoch": second, "revision": 3],
                                 row("a", 0, second), row("b", 1, second),
                                 ["type": "thread.position", "threadId": "thread", "epoch": second, "id": "c", "index": 2],
                                 row("d", 3, second), ready(second, count: 4, revision: 3)]))
        #expect(shown.order == ["a", "b", "c", "d"])
        model.disconnect()
        await drain()
        replacement.finishShutdown()
        await model.disconnectAndWait()
    }

    /// The bridge diffs a whole-thread pass against what native acknowledged. A pass that begins
    /// while the new runtime's staging is still filling (its tail's fence not in yet) carries on
    /// from that staging: seeded again from the copy on screen, it would bring back a request the
    /// bridge has already told native was answered, and never send its answer again.
    @Test func anAnsweredRequestNeverComesBackWhenTheWholeWindowBeginsBeforeTheTailsFence() async throws {
        let sessions = Sessions()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await model.connect(target: try target("mac", port: SpikeFixture.port), directory: directory)
        let direct = try #require(sessions.values.first)
        direct.emit("ready")
        await drain()
        model.open("thread")
        let first = try #require(model.thread?.epoch)
        model.receive(try frame([reset(first), row("a", 0, first), request(first, state: "pending"),
                                 ready(first, count: 1, revision: 1)]))
        let shown = try #require(model.thread)
        #expect(shown.approvals.map(\.id) == ["req-1"])

        let relay = Task { await model.connect(target: try target("mac", port: SpikeFixture.port + 1), directory: directory) }
        await drain()
        direct.finishShutdown()
        try await relay.value
        let replacement = try #require(sessions.values.last)
        let second = try #require(model.thread?.epoch)

        // The new runtime's cold reset, the row and the request's answer, acknowledged; then the
        // whole window begins before any fence, and sends only what changed since.
        model.receive(try frame([["type": "thread.reset", "threadId": "thread", "epoch": second, "revision": 2],
                                 row("a", 0, second), request(second, state: "approved")]))
        model.receive(try frame([["type": "thread.snapshot.begin", "threadId": "thread", "epoch": second, "revision": 3],
                                 ready(second, count: 1, revision: 3)]))
        #expect(shown.order == ["a"])
        #expect(shown.approvals.isEmpty)
        #expect(shown.interactions["req-1"]?.state == "approved")
        model.disconnect()
        await drain()
        replacement.finishShutdown()
        await model.disconnectAndWait()
    }

    /// A route change keeps the thread's model and starts the navigation count again, so the new
    /// runtime's generation can equal the one a reveal began under. That reveal drew the old
    /// runtime's screen and must not tell the new one its first screen is shown.
    @Test func aRevealFromTheRetiredRuntimeNeverReportsTheNewRuntimesFirstScreen() async throws {
        let sessions = Sessions()
        let model = ClientModel(now: { 0 }, frames: .immediate, makeRuntime: sessions.make)
        await model.connect(target: try target("mac", port: SpikeFixture.port), directory: directory)
        let direct = try #require(sessions.values.first)
        direct.emit("ready")
        await drain()
        model.open("thread")
        let shown = try #require(model.thread)
        let revealing = model.showing(shown)

        let relay = Task { await model.connect(target: try target("mac", port: SpikeFixture.port + 1), directory: directory) }
        await drain()
        direct.finishShutdown()
        try await relay.value
        let replacement = try #require(sessions.values.last)
        #expect(model.thread === shown)
        #expect(shown.epoch == revealing.epoch)

        model.threadShown(shown, at: revealing)
        #expect(!replacement.actions.contains { $0["type"] as? String == "thread.shown" })
        model.threadShown(shown, at: model.showing(shown))
        #expect(replacement.actions.filter { $0["type"] as? String == "thread.shown" }.count == 1)
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
    private func ready(_ epoch: Int, count: Int, revision: Int, tail: Bool = false) -> [String: Any] {
        var patch: [String: Any] = ["type": "thread.ready", "threadId": "thread", "epoch": epoch, "count": count, "revision": revision]
        if tail { patch["tail"] = true }
        return patch
    }
    private func request(_ epoch: Int, state: String) -> [String: Any] {
        let options: [[String: Any]] = [["id": "allow-once", "label": "Allow once", "kind": "allow_once"]]
        return ["type": "thread.interaction", "threadId": "thread", "epoch": epoch, "id": "req-1", "row": [
            "id": "req-1", "kind": "approval", "state": state, "title": "Migrate schema",
            "description": "", "command": "bun run db:migrate", "options": options,
            "decisions": [["verb": "allow_once", "option": 0, "label": "Allow once", "scope": "", "emphasis": "primary"]],
            "truncated": false, "summarized": "", "wholeState": "loaded", "wholeRetryable": false,
        ] as [String: Any]]
    }
    private func row(_ id: String, _ index: Int, _ epoch: Int) -> [String: Any] {
        var patch = item(id, epoch: epoch)
        if var row = patch["row"] as? [String: Any] { row["index"] = index; patch["row"] = row }
        return patch
    }
    private func item(_ id: String, epoch: Int) -> [String: Any] {
        let row: [String: Any] = ["id": id, "index": 0, "type": "message", "role": "user", "text": id,
                                  "complete": true, "createdAt": 0, "agentId": "root", "truncated": false]
        return ["type": "thread.item", "threadId": "thread", "epoch": epoch, "id": id, "row": row]
    }
    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
    /// Keeps the main thread busy, as a long layout does, until `done` or `seconds`.
    private func busy(until done: () -> Bool, for seconds: TimeInterval = 5) {
        let deadline = Date().addingTimeInterval(seconds)
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
    /// The acknowledgements so far, forgetting them.
    func takeAcks() -> [Bool] { lock.withLock { defer { acknowledged = [] }; return acknowledged } }
    /// One frame of `patches`, as the runtime delivers it.
    func send(_ patches: [[String: Any]]) {
        guard let data = try? JSONSerialization.data(withJSONObject: patches) else { return }
        receive(data)
    }
    func stop(completion: @escaping @Sendable () -> Void) { lock.withLock { stopped = completion } }
    func finishShutdown() {
        let completion = lock.withLock { let result = stopped; stopped = nil; return result }
        completion?()
    }
    func emit(_ state: String) { receive(Data("[{\"type\":\"connection\",\"state\":\"\(state)\"}]".utf8)) }
}
