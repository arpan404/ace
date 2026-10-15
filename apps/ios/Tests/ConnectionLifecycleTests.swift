import Foundation
import Testing
@testable import Ace

@Suite @MainActor struct ConnectionLifecycleTests {
    @Test func replacingAConnectionWaitsForShutdownAndIgnoresItsLateUpdates() async throws {
        let sessions = Sessions()
        let model = ClientModel(now: { 0 }, makeRuntime: sessions.make)
        await model.connect(target: try target("first"), directory: directory)
        let first = try #require(sessions.values.first)
        first.emit("ready")
        await drain()
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
        await drain()
        #expect(model.connection == "ready")
        #expect(model.error == "second")
        model.disconnect()
        await drain()
        second.finishShutdown()
        await model.disconnectAndWait()
    }

    @Test func disconnectCancelsAReplacementWaitingForThePreviousRuntime() async throws {
        let sessions = Sessions()
        let model = ClientModel(now: { 0 }, makeRuntime: sessions.make)
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
        let model = ClientModel(now: { 0 }, makeRuntime: sessions.make)
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

    private var directory: URL { URL(fileURLWithPath: "/unused-lifecycle-contract") }
    private func target(_ host: String) throws -> ConnectionTarget {
        ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:9841")),
                         hostId: host, deviceId: "phone", pin: nil, credential: { "{}" })
    }
    private func drain() async { for _ in 0..<20 { await Task.yield() } }
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
    func invoke(_ name: String, json: String) {}
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { lock.withLock { stopped = completion } }
    func finishShutdown() {
        let completion = lock.withLock { let result = stopped; stopped = nil; return result }
        completion?()
    }
    func emit(_ state: String) { receive(Data("[{\"type\":\"connection\",\"state\":\"\(state)\"}]".utf8)) }
}
