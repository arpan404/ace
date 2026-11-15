import Foundation
import Testing
@testable import Ace

/// Pictures held to their source's current delivery, as the shared script sets it
/// (`media.delivery`, ADR 0147 §4): Swift keeps only the (generation, path) it was last given.
@Suite struct DeliveryGateTests {
    private final class Log: @unchecked Sendable {
        private let lock = NSLock()
        private var shown: [Int] = []
        private var acked: [BrowserAck] = []
        func show(_ sequence: Int) { lock.withLock { shown.append(sequence) } }
        func ack(_ value: BrowserAck) { lock.withLock { acked.append(value) } }
        var pictures: [Int] { lock.withLock { shown } }
        var acks: [BrowserAck] { lock.withLock { acked } }
    }
    /// A real H.264 stream of one thread: keyframes only, each decodable on its own.
    private func stream() throws -> (Int) -> BrowserVideoChunk {
        let (description, encoded) = try H264DecodeTests.encode(width: 320, height: 240, frames: 1)
        return { sequence in
            BrowserVideoChunk(threadId: "thread", sequence: sequence, timestamp: 0, width: 320, height: 240,
                              codedWidth: 320, codedHeight: 240, codec: "avc1.42E033", key: true,
                              description: description, tabId: "tab", bytes: encoded[0])
        }
    }
    private func settle(_ log: Log, acks count: Int) async throws {
        for _ in 0..<400 where log.acks.count < count { try await Task.sleep(for: .milliseconds(5)) }
        try await Task.sleep(for: .milliseconds(50))
    }

    @Test func aStalePictureAfterARebindIsNeitherDrawnNorAcknowledged() async throws {
        let chunk = try stream()
        let log = Log()
        let renderer = BrowserRenderer(threadId: "thread", present: { log.show($0.sequence) }, ack: { log.ack($0) })
        defer { renderer.close() }
        renderer.delivery("thread", MediaDelivery(generation: 1, path: "media-a"))
        renderer.receive(chunk(1), path: "media-a")
        try await settle(log, acks: 1)
        // The view subscribed again on another media connection, and the daemon said so.
        renderer.delivery("thread", MediaDelivery(generation: 2, path: nil))
        renderer.delivery("thread", MediaDelivery(generation: 2, path: "media-b"))
        renderer.receive(chunk(2), path: "media-a")
        renderer.receive(chunk(3), path: "media-b")
        try await settle(log, acks: 2)
        #expect(log.pictures == [1, 3])
        #expect(log.acks == [BrowserAck(sequence: 1, generation: 1), BrowserAck(sequence: 3, generation: 2)])
    }

    @Test func aKeyframeThatArrivesBeforeTheReplyStillShowsOnAStaticView() async throws {
        let chunk = try stream()
        let log = Log()
        let renderer = BrowserRenderer(threadId: "thread", present: { log.show($0.sequence) }, ack: { log.ack($0) })
        defer { renderer.close() }
        renderer.delivery("thread", MediaDelivery(generation: 4, path: nil))
        // A still page: one keyframe on the media connection, the channel's replay, then nothing.
        renderer.receive(chunk(7), path: "media-a")
        renderer.receive(chunk(9), path: MediaDelivery.channel)
        try await Task.sleep(for: .milliseconds(100))
        #expect(log.pictures.isEmpty && log.acks.isEmpty)
        renderer.delivery("thread", MediaDelivery(generation: 4, path: "media-a"))
        try await settle(log, acks: 1)
        #expect(log.pictures == [7])
        #expect(log.acks == [BrowserAck(sequence: 7, generation: 4)])
    }

    @Test func anAckCarriesTheGenerationItsPictureCameForAndNoneBeforeTheScriptSetOne() async throws {
        let chunk = try stream()
        let log = Log()
        let renderer = BrowserRenderer(threadId: "thread", present: { log.show($0.sequence) }, ack: { log.ack($0) })
        defer { renderer.close() }
        renderer.receive(chunk(1))
        try await settle(log, acks: 1)
        renderer.delivery("thread", MediaDelivery(generation: 12, path: MediaDelivery.channel))
        renderer.receive(chunk(2))
        try await settle(log, acks: 2)
        #expect(log.acks.map(\.generation) == [nil, 12])
    }

    // The gate alone, on stand-in pictures.
    private struct Picture: GatedPicture, Equatable { let id: Int; let key: Bool; let byteCount: Int }

    @Test func pendingWaysKeepTheirNewestKeyframeAndItsDeltasAndTheSettledOneIsReleased() {
        var gate = DeliveryGate<Picture>()
        _ = gate.set(MediaDelivery(generation: 1, path: nil))
        let delta = Picture(id: 0, key: false, byteCount: 10)
        for (picture, path) in [(delta, "a"), (Picture(id: 1, key: true, byteCount: 10), "a"), (Picture(id: 2, key: false, byteCount: 10), "a"),
                                (Picture(id: 3, key: true, byteCount: 10), "channel")] {
            #expect({ if case .hold = gate.arrive(picture, path: path, at: 0) { true } else { false } }())
        }
        let change = gate.set(MediaDelivery(generation: 1, path: "a"))
        #expect(change.released.map(\.id) == [1, 2] && !change.reset && change.keyframe == nil)
        #expect({ if case .drop = gate.arrive(Picture(id: 4, key: true, byteCount: 1), path: "channel", at: 0) { true } else { false } }())
    }

    @Test func pastFourMegabytesOrTwoSecondsOnlyTheKeyframeIsKeptAndAFreshOneIsAskedFor() {
        for (bytes, at) in [(4 * 1024 * 1024, 0.5), (10, 2.5)] {
            var gate = DeliveryGate<Picture>()
            _ = gate.set(MediaDelivery(generation: 1, path: nil))
            _ = gate.arrive(Picture(id: 1, key: true, byteCount: 10), path: "a", at: 0)
            _ = gate.arrive(Picture(id: 2, key: false, byteCount: bytes), path: "a", at: at)
            _ = gate.arrive(Picture(id: 3, key: false, byteCount: 10), path: "a", at: at)
            let change = gate.set(MediaDelivery(generation: 1, path: "a"))
            #expect(change.released.map(\.id) == [1], "\(bytes) bytes at \(at) s")
            #expect(change.keyframe?.id == 1)
        }
    }

    @Test func aNewGenerationStartsOverAndDropsWhatTheOldOneHeld() {
        var gate = DeliveryGate<Picture>()
        #expect(!gate.set(MediaDelivery(generation: 1, path: nil)).reset)
        _ = gate.arrive(Picture(id: 1, key: true, byteCount: 10), path: "a", at: 0)
        #expect(gate.set(MediaDelivery(generation: 2, path: nil)).reset)
        #expect(gate.set(MediaDelivery(generation: 2, path: "a")).released.isEmpty)
    }
}
