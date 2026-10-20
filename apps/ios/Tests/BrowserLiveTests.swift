import CoreVideo
import Foundation
import Testing
@testable import Ace

/// The live view's native path, from the runtime's socket hub to the screen and back to the
/// daemon as acknowledgements, with the bridge recorded.
@Suite @MainActor struct BrowserLiveTests {
    @Test func theThreadOffersItsBrowserOnlyForTheVisitTheProbeAnswered() async throws {
        let (model, _) = try await connected()
        let epoch = try #require(model.thread?.epoch)
        model.receive(try frame([["type": "browser.available", "threadId": "thread", "epoch": epoch, "live": true]]))
        #expect(model.threadHasBrowser)
        model.receive(try frame([["type": "browser.available", "threadId": "thread", "epoch": epoch, "live": false]]))
        #expect(!model.threadHasBrowser)
        // A late answer for an earlier visit of the same thread isn't believed.
        model.open("thread")
        model.receive(try frame([["type": "browser.available", "threadId": "thread", "epoch": epoch, "live": true]]))
        #expect(!model.threadHasBrowser)
    }

    @Test func aBrowserOpenedDuringAnUnchangedWorkingTurnIsFoundByFollowingIt() async throws {
        let (model, session) = try await connected()
        let epoch = try #require(model.thread?.epoch)
        model.receive(try frame([working(epoch), ["type": "browser.available", "threadId": "thread", "epoch": epoch, "live": false]]))
        var waits: [Duration] = []
        // The agent opens its browser after the second probe; the state stays Working throughout.
        await model.followBrowser { delay in
            waits.append(delay)
            if self.probes(session) == 2 {
                model.receive(try self.frame([["type": "browser.available", "threadId": "thread", "epoch": epoch, "live": true]]))
            }
        }
        #expect(model.threadHasBrowser)
        #expect(probes(session) == 2)
        #expect(waits == Array(ClientModel.browserFollowDelays.prefix(3)))
    }
    @Test func followingABrowserIsBoundedAndEndsOnLeavingTheThread() async throws {
        let (model, session) = try await connected()
        model.receive(try frame([working(try #require(model.thread?.epoch))]))
        await model.followBrowser { _ in }
        #expect(probes(session) == ClientModel.browserFollowDelays.count)
        model.open("thread")
        model.receive(try frame([working(try #require(model.thread?.epoch))]))
        let before = probes(session)
        await model.followBrowser { _ in if self.probes(session) == before + 1 { model.back() } }
        #expect(probes(session) == before + 1)
        // The view's task is cancelled when the thread leaves the screen or the app goes inactive.
        model.open("thread")
        model.receive(try frame([working(try #require(model.thread?.epoch))]))
        let follow = Task { await model.followBrowser { try await Task.sleep(for: $0) } }
        follow.cancel()
        await follow.value
        #expect(probes(session) == before + 1)
    }

    @Test func openingSubscribesAtTheViewsSizeAndClosingReleasesIt() async throws {
        let (model, session) = try await connected()
        model.openBrowser(size: CGSize(width: 390, height: 700), scale: 3)
        let open = try #require(session.browserActions.last)
        #expect(open["kind"] as? String == "open")
        #expect(open["threadId"] as? String == "thread")
        let viewport = try #require(open["viewport"] as? [String: Any])
        #expect(viewport["width"] as? Double == 390 && viewport["devicePixelRatio"] as? Double == 3)
        model.closeBrowser()
        #expect(session.browserActions.last?["kind"] as? String == "close")
        #expect(model.browser.threadId == nil)
    }

    @Test func videoBeforeItsKeyframeIsAcknowledgedAndABrokenKeyframeAsksForAnother() async throws {
        let (model, session) = try await connected()
        model.openBrowser(size: CGSize(width: 390, height: 700), scale: 3)
        // Another thread's chunks are not this view's: never decoded, never acknowledged.
        session.hub.deliver(chunk(sequence: 2, key: false, threadId: "other"))
        session.hub.deliver(chunk(sequence: 3, key: false))
        try await until { session.acks.count == 1 }
        #expect(session.acks[0]["sequence"] as? Int == 3)
        #expect(session.acks[0]["keyframe"] == nil)
        // A keyframe whose bytes don't decode: the newest chunk is acknowledged with a keyframe request.
        session.hub.deliver(chunk(sequence: 4, key: true))
        try await until { session.acks.count == 2 }
        #expect(session.acks[1]["sequence"] as? Int == 4)
        #expect(session.acks[1]["keyframe"] as? Bool == true)
        // Nothing was decoded, so the view still waits for its first picture.
        #expect(model.browser.nextPicture() == nil)
        #expect(model.browser.pageSize == nil)
    }

    @Test func everyDecodedChunkIsAcknowledgedAndTheScreenDrawsOnlyTheNewest() async throws {
        let (model, session) = try await connected()
        model.openBrowser(size: CGSize(width: 390, height: 700), scale: 3)
        for chunk in try realVideo(threadId: "thread", from: 20, frames: 3) { session.hub.deliver(chunk) }
        // Acknowledged as each is decoded, before any screen refresh draws one.
        try await until { session.acks.count == 3 }
        #expect(session.acks.map { $0["sequence"] as? Int } == [20, 21, 22])
        #expect(session.acks.allSatisfy { $0["keyframe"] == nil })
        #expect(model.browser.pageSize == nil)
        // The next refresh draws the newest picture; the older ones are dropped.
        let drawn = try #require(model.browser.nextPicture())
        #expect(drawn.sequence == 22)
        #expect(CVPixelBufferGetWidth(drawn.image) == 320)
        #expect(model.browser.nextPicture() == nil)
        // Input maps to the page's CSS size, not the coded picture's.
        #expect(model.browser.pageSize == CGSize(width: 400, height: 300))
    }

    @Test func inTheBackgroundOnlyTheNewestAcknowledgementWaitsSoTheDaemonPauses() async throws {
        let (model, session) = try await connected()
        model.openBrowser(size: CGSize(width: 390, height: 700), scale: 3)
        model.browser.setVisible(false)
        session.hub.deliver(chunk(sequence: 3, key: false))
        for chunk in try realVideo(threadId: "thread", from: 20, frames: 2) { session.hub.deliver(chunk) }
        // Still decoded while hidden.
        var drawn: BrowserPicture?
        try await until {
            drawn = model.browser.nextPicture() ?? drawn
            return drawn?.sequence == 21
        }
        try await Task.sleep(for: .milliseconds(50))
        #expect(session.acks.isEmpty)
        model.browser.setVisible(true)
        #expect(session.acks.map { $0["sequence"] as? Int } == [21])
    }

    @Test func pageStateFollowsTheOpenViewOnly() async throws {
        let (model, _) = try await connected()
        let page: [String: Any] = ["type": "browser.page", "threadId": "thread", "tabId": "t",
                                   "page": ["focus": ["type": "email", "rect": ["x": 1, "y": 2, "width": 3, "height": 4]]]]
        model.receive(try frame([page]))
        #expect(model.browser.page == nil)
        model.openBrowser(size: CGSize(width: 390, height: 700), scale: 3)
        model.receive(try frame([page]))
        #expect(model.browser.page?.focus?.type == "email")
        model.receive(try frame([["type": "browser.page", "threadId": "thread", "tabId": "t", "page": NSNull()]]))
        #expect(model.browser.page == nil)
    }

    @Test func aViewOnlyGrantSendsNoInput() async throws {
        let (model, session) = try await connected()
        model.openBrowser(size: CGSize(width: 390, height: 700), scale: 3)
        model.browserInput([.touch(event: "touchStart", points: [.init(x: 1, y: 1, id: 0)])])
        #expect(session.browserActions.last?["kind"] as? String == "input")
        model.canOperate = false
        let count = session.browserActions.count
        model.browserInput([.touch(event: "touchEnd", points: [])])
        model.browserHistory("reload")
        #expect(session.browserActions.count == count)
    }

    // MARK: - Reopen fence

    @Test func aReopenedViewNeverDrawsOrAcknowledgesTheEarlierViewsVideo() async throws {
        let hub = BrowserStreamHub()
        let model = BrowserLiveModel()
        let first = AckLog(), second = AckLog()
        model.open(threadId: "A", streams: hub, ack: { first.record($0) })
        for chunk in try realVideo(threadId: "A", from: 10, frames: 1) { hub.deliver(chunk) }
        try await until { first.count == 1 }
        model.open(threadId: "B", streams: hub, ack: { second.record($0) })
        #expect(model.nextPicture() == nil)
        #expect(model.pageSize == nil)
        // Chunks for the earlier thread aren't this view's; the current one's are drawn and acknowledged.
        for chunk in try realVideo(threadId: "A", from: 11, frames: 1) + realVideo(threadId: "B", from: 12, frames: 1) {
            hub.deliver(chunk)
        }
        try await until { second.count == 1 }
        #expect(second.sequences == [12])
        #expect(first.sequences == [10])
        #expect(model.nextPicture()?.sequence == 12)
    }

    @Test func aClosedViewSendsNoAcknowledgementEvenOneOwedFromTheBackground() {
        let log = AckLog()
        let acks = BrowserAcks(visible: false, send: { log.record($0) })
        acks.acknowledge(BrowserAck(sequence: 3))
        acks.close()
        acks.acknowledge(BrowserAck(sequence: 4))
        acks.setVisible(true)
        #expect(log.count == 0)
    }

    @Test func aKeyframeRequestOwedFromTheBackgroundIsStillMadeOnReturn() {
        let log = AckLog()
        let acks = BrowserAcks(visible: false, send: { log.record($0) })
        acks.acknowledge(BrowserAck(sequence: 3, keyframe: true))
        acks.acknowledge(BrowserAck(sequence: 5))
        acks.setVisible(true)
        #expect(log.values == [BrowserAck(sequence: 5, keyframe: true)])
        acks.acknowledge(BrowserAck(sequence: 6))
        #expect(log.values.last == BrowserAck(sequence: 6))
    }

    // MARK: - Helpers

    private func connected() async throws -> (ClientModel, BrowserRecorder) {
        let session = BrowserRecorder()
        let model = ClientModel(now: { 0 }, makeRuntime: { _, _, _, _ in session })
        let target = ConnectionTarget(endpoint: try #require(URL(string: "ws://127.0.0.1:1")), hostId: "host", deviceId: "device", pin: nil, credential: { "{}" })
        await model.connect(target: target, directory: FileManager.default.temporaryDirectory)
        model.open("thread")
        return (model, session)
    }
    /// A chunk whose bytes aren't real H.264: a keyframe of it fails to decode.
    private func chunk(sequence: Int, key: Bool, threadId: String = "thread") -> BrowserVideoChunk {
        BrowserVideoChunk(threadId: threadId, sequence: sequence, timestamp: 0, width: 390, height: 700, codedWidth: 1170,
                          codedHeight: 2100, codec: "avc1.42E033", key: key,
                          description: key ? Data([1, 0x42, 0xe0, 0x33, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0xe0, 0x33, 1, 0, 2, 0x68, 0xce]) : nil,
                          tabId: nil, bytes: Data([0, 0, 0, 2, 0x65, 0x88]))
    }
    /// Real H.264 from VideoToolbox, as the daemon's chunks: a keyframe then deltas, on a 400 × 300 CSS pixel page.
    private func realVideo(threadId: String, from sequence: Int, frames: Int) throws -> [BrowserVideoChunk] {
        let (description, encoded) = try H264DecodeTests.encode(width: 320, height: 240, frames: frames)
        return encoded.enumerated().map { index, bytes in
            BrowserVideoChunk(threadId: threadId, sequence: sequence + index, timestamp: 0, width: 400, height: 300, codedWidth: 320,
                              codedHeight: 240, codec: "avc1.42E033", key: index == 0, description: index == 0 ? description : nil,
                              tabId: nil, bytes: bytes)
        }
    }
    private func frame(_ values: [[String: Any]]) throws -> Data { try JSONSerialization.data(withJSONObject: values) }
    private func working(_ epoch: Int) -> [String: Any] {
        ["type": "thread.controls", "threadId": "thread", "epoch": epoch,
         "row": ["busy": true, "delivery": "queue", "alternate": NSNull(), "canStop": true, "provider": "codex", "model": "", "switching": ""]]
    }
    private func probes(_ session: BrowserRecorder) -> Int { session.browserActions.filter { $0["kind"] as? String == "probe" }.count }
    private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<400 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Timed out")
    }
}

private final class AckLog: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [BrowserAck] = []
    func record(_ value: BrowserAck) { lock.withLock { recorded.append(value) } }
    var values: [BrowserAck] { lock.withLock { recorded } }
    var count: Int { values.count }
    var sequences: [Int] { values.map(\.sequence) }
}

private final class BrowserRecorder: ClientSession, @unchecked Sendable {
    let hub = BrowserStreamHub()
    private let lock = NSLock()
    private var actions: [[String: Any]] = []
    var browserStreams: BrowserStreamHub? { hub }
    var browserActions: [[String: Any]] {
        lock.withLock { actions.compactMap { $0["type"] as? String == "browser" ? $0["action"] as? [String: Any] : nil } }
    }
    var acks: [[String: Any]] { browserActions.filter { $0["kind"] as? String == "ack" } }
    func start(itemLimit: Int) {}
    func invoke(_ name: String, json: String) {
        guard let value = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return }
        lock.withLock { actions.append(value) }
    }
    func acknowledge(accepted: Bool) {}
    func stop(completion: @escaping @Sendable () -> Void) { completion() }
}
