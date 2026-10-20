import Foundation
import Testing
import UIKit
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

    @Test func aJPEGFrameIsShownThenAcknowledged() async throws {
        let (model, session) = try await connected()
        let surface = RecordingSurface()
        model.browser.surface = surface
        model.openBrowser(size: CGSize(width: 390, height: 700), scale: 3)
        session.hub.deliver(.frame(BrowserJPEGFrame(threadId: "thread", sequence: 5, timestamp: 0, width: 390, height: 700,
                                                    tabId: "t", bytes: try jpeg())))
        try await until { session.acks.count == 1 }
        #expect(surface.shown == [5])
        #expect(model.browser.pageSize == CGSize(width: 390, height: 700))
        #expect(session.acks.first?["sequence"] as? Int == 5)
        #expect(session.acks.first?["video"] == nil)
        // Another thread's pictures are not this view's.
        session.hub.deliver(.frame(BrowserJPEGFrame(threadId: "other", sequence: 6, timestamp: 0, width: 390, height: 700,
                                                    tabId: nil, bytes: try jpeg())))
        session.hub.deliver(.frame(BrowserJPEGFrame(threadId: "thread", sequence: 7, timestamp: 0, width: 390, height: 700,
                                                    tabId: nil, bytes: Data([1, 2, 3]))))
        // A frame that can't be decoded is still acknowledged, so the next one comes.
        try await until { session.acks.count == 2 }
        #expect(session.acks.map { $0["sequence"] as? Int } == [5, 7])
        #expect(surface.shown == [5])
    }

    @Test func videoBeforeItsKeyframeIsAcknowledgedAndABrokenKeyframeAsksForAnother() async throws {
        let (model, session) = try await connected()
        model.browser.surface = RecordingSurface()
        model.openBrowser(size: CGSize(width: 390, height: 700), scale: 3)
        session.hub.deliver(.video(chunk(sequence: 3, key: false)))
        try await until { session.acks.count == 1 }
        #expect(session.acks[0]["video"] as? Bool == true)
        #expect(session.acks[0]["keyframe"] == nil)
        // A keyframe whose bytes don't decode: the newest chunk is acknowledged with a keyframe request.
        session.hub.deliver(.video(chunk(sequence: 4, key: true)))
        try await until { session.acks.count == 2 }
        #expect(session.acks[1]["sequence"] as? Int == 4)
        #expect(session.acks[1]["keyframe"] as? Bool == true)
    }

    @Test func realVideoIsDecodedShownAndAcknowledgedCumulatively() async throws {
        let (model, session) = try await connected()
        let surface = RecordingSurface()
        model.browser.surface = surface
        model.openBrowser(size: CGSize(width: 390, height: 700), scale: 3)
        let (description, encoded) = try H264DecodeTests.encode(width: 320, height: 240, frames: 2)
        for (index, bytes) in encoded.enumerated() {
            session.hub.deliver(.video(BrowserVideoChunk(
                threadId: "thread", sequence: 20 + index, timestamp: 0, width: 400, height: 300, codedWidth: 320, codedHeight: 240,
                codec: "avc1.42E033", key: index == 0, description: index == 0 ? description : nil, tabId: nil, bytes: bytes)))
        }
        try await until { session.acks.count == 2 }
        #expect(surface.shown == [20, 21])
        #expect(session.acks.map { $0["sequence"] as? Int } == [20, 21])
        #expect(session.acks.allSatisfy { $0["video"] as? Bool == true && $0["keyframe"] == nil })
        // Input maps to the page's CSS size, not the coded picture's.
        #expect(model.browser.pageSize == CGSize(width: 400, height: 300))
    }

    @Test func inTheBackgroundAcknowledgementsWaitSoTheDaemonPauses() async throws {
        let (model, session) = try await connected()
        model.browser.surface = RecordingSurface()
        model.openBrowser(size: CGSize(width: 390, height: 700), scale: 3)
        model.browser.setVisible(false)
        session.hub.deliver(.video(chunk(sequence: 3, key: false)))
        session.hub.deliver(.video(chunk(sequence: 4, key: false)))
        session.hub.deliver(.frame(BrowserJPEGFrame(threadId: "thread", sequence: 8, timestamp: 0, width: 390, height: 700,
                                                    tabId: nil, bytes: try jpeg())))
        try await until { model.browser.pageSize != nil }
        try await Task.sleep(for: .milliseconds(50))
        #expect(session.acks.isEmpty)
        model.browser.setVisible(true)
        #expect(session.acks.map { $0["sequence"] as? Int } == [8, 4])
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

    @Test func reopeningDropsAQueuedPictureAndItsAcknowledgement() async throws {
        let hop = QueuedHop()
        let hub = BrowserStreamHub()
        let model = BrowserLiveModel()
        model.mainHop = { hop.call($0) }
        let surface = RecordingSurface()
        model.surface = surface
        let staleAcks = AckLog()
        let freshAcks = AckLog()
        model.open(threadId: "A", streams: hub, ack: { staleAcks.record($0) })
        hub.deliver(.frame(BrowserJPEGFrame(threadId: "A", sequence: 11, timestamp: 0, width: 390, height: 700,
                                                     tabId: nil, bytes: try jpeg())))
        // Close A and open B before A's queued present runs.
        model.open(threadId: "B", streams: hub, ack: { freshAcks.record($0) })
        try await until { hop.count >= 1 }
        for block in hop.take() { block() }
        #expect(surface.shown.isEmpty)
        #expect(staleAcks.count == 0)
        #expect(freshAcks.count == 0)
        #expect(model.pageSize == nil)
        // The current generation still presents and acknowledges.
        hub.deliver(.frame(BrowserJPEGFrame(threadId: "B", sequence: 12, timestamp: 0, width: 390, height: 700,
                                                     tabId: nil, bytes: try jpeg())))
        try await until { hop.count >= 1 }
        for block in hop.take() { block() }
        #expect(surface.shown == [12])
        #expect(freshAcks.sequences == [12])
    }

    @Test func reopeningDropsAQueuedAcknowledgement() async throws {
        let hop = QueuedHop()
        let hub = BrowserStreamHub()
        let model = BrowserLiveModel()
        model.mainHop = { hop.call($0) }
        model.surface = RecordingSurface()
        let staleAcks = AckLog()
        let freshAcks = AckLog()
        model.open(threadId: "A", streams: hub, ack: { staleAcks.record($0) })
        // Bytes that can't be decoded are acknowledged at once, without a picture.
        hub.deliver(.frame(BrowserJPEGFrame(threadId: "A", sequence: 13, timestamp: 0, width: 390, height: 700,
                                                     tabId: nil, bytes: Data([1, 2, 3]))))
        model.open(threadId: "B", streams: hub, ack: { freshAcks.record($0) })
        try await until { hop.count >= 1 }
        for block in hop.take() { block() }
        #expect(staleAcks.count == 0)
        #expect(freshAcks.count == 0)
        // The current generation still acknowledges.
        hub.deliver(.frame(BrowserJPEGFrame(threadId: "B", sequence: 14, timestamp: 0, width: 390, height: 700,
                                                     tabId: nil, bytes: Data([1, 2, 3]))))
        try await until { hop.count >= 1 }
        for block in hop.take() { block() }
        #expect(freshAcks.sequences == [14])
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
    private func chunk(sequence: Int, key: Bool) -> BrowserVideoChunk {
        BrowserVideoChunk(threadId: "thread", sequence: sequence, timestamp: 0, width: 390, height: 700, codedWidth: 1170,
                          codedHeight: 2100, codec: "avc1.42E033", key: key,
                          description: key ? Data([1, 0x42, 0xe0, 0x33, 0xff, 0xe1, 0, 4, 0x67, 0x42, 0xe0, 0x33, 1, 0, 2, 0x68, 0xce]) : nil,
                          tabId: nil, bytes: Data([0, 0, 0, 2, 0x65, 0x88]))
    }
    private func jpeg() throws -> Data {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        return try #require(image.jpegData(compressionQuality: 0.8))
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

@MainActor private final class RecordingSurface: BrowserPictureSink {
    var shown: [Int] = []
    func show(_ picture: BrowserPicture) { shown.append(picture.sequence) }
}

/// Queued main-actor hop for reopen-fence tests: renderer callbacks schedule here off the main
/// thread, and the test flushes the blocks on the main actor to interleave close/open deterministically.
private final class QueuedHop: @unchecked Sendable {
    private let lock = NSLock()
    private var blocks: [@Sendable () -> Void] = []
    func call(_ block: @escaping @Sendable () -> Void) { lock.withLock { blocks.append(block) } }
    var count: Int { lock.withLock { blocks.count } }
    func take() -> [@Sendable () -> Void] { lock.withLock { let taken = blocks; blocks = []; return taken } }
}

private final class AckLog: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [BrowserAck] = []
    func record(_ value: BrowserAck) { lock.withLock { values.append(value) } }
    var count: Int { lock.withLock { values.count } }
    var sequences: [Int] { lock.withLock { values.map(\.sequence) } }
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
