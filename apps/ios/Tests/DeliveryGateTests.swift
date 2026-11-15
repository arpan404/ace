import CoreGraphics
import Foundation
import ImageIO
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
    private struct Picture: GatedPicture, Equatable {
        let id: Int; let key: Bool; let byteCount: Int
        var pictureId: PictureId { PictureId(streamId: "s", sequence: id) }
    }

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
            #expect(change.keyframe?.sequence == 1)
        }
    }

    @Test func aNewGenerationStartsOverAndDropsWhatTheOldOneHeld() {
        var gate = DeliveryGate<Picture>()
        #expect(!gate.set(MediaDelivery(generation: 1, path: nil)).reset)
        _ = gate.arrive(Picture(id: 1, key: true, byteCount: 10), path: "a", at: 0)
        #expect(gate.set(MediaDelivery(generation: 2, path: nil)).reset)
        #expect(gate.set(MediaDelivery(generation: 2, path: "a")).released.isEmpty)
    }

    @Test func aNewerGenerationIsKeptWhenAnOlderOneArrivesAfterIt() {
        var gate = DeliveryGate<Picture>()
        _ = gate.set(MediaDelivery(generation: 8, path: "b", revision: 2))
        // Generation 7, read before 8 was set, reaches the gate after it.
        let late = gate.set(MediaDelivery(generation: 7, path: "a", revision: 1))
        #expect(!late.accepted && !late.reset && late.released.isEmpty)
        #expect(gate.delivery == MediaDelivery(generation: 8, path: "b", revision: 2))
        #expect({ if case .show(8) = gate.arrive(Picture(id: 1, key: true, byteCount: 1), path: "b", at: 0) { true } else { false } }())
    }

    @Test func aFailedSubscribeFallingBackToTheDeliveryItReplacedIsTaken() {
        var gate = DeliveryGate<Picture>()
        _ = gate.set(MediaDelivery(generation: 7, path: "a", revision: 1))
        _ = gate.set(MediaDelivery(generation: 8, path: nil, revision: 2))
        // Subscribe 8 failed; the script restores 7, whose way still holds, as its latest update.
        let restored = gate.set(MediaDelivery(generation: 7, path: "a", revision: 3))
        #expect(restored.accepted && restored.reset)
        #expect({ if case .show(7) = gate.arrive(Picture(id: 1, key: true, byteCount: 1), path: "a", at: 0) { true } else { false } }())
    }

    @Test func aPendingSixMegabyteKeyframeHoldsLessThanFourMegabytes() {
        var gate = DeliveryGate<Picture>()
        _ = gate.set(MediaDelivery(generation: 1, path: nil))
        _ = gate.arrive(Picture(id: 1, key: true, byteCount: 6 * 1024 * 1024), path: "a", at: 0)
        #expect(gate.heldBytes < 4 * 1024 * 1024)
        // Settled on it, it still asks for a fresh keyframe in its name.
        let change = gate.set(MediaDelivery(generation: 1, path: "a"))
        #expect(change.released.isEmpty && change.keyframe != nil)
    }

    @Test func aStalePosterAfterASwitchIsNeverDrawn() async throws {
        let hub = BrowserStreamHub()
        // Two replies' posters, each swapped for its token as it passed: thread A's, then B's.
        let named = { (thread: String) -> String in
            let reply = #"{"type":"browser.result","requestId":"r-\#(thread)","ok":true,"media":{"connection":"mc_aaaaaaaa","poster":{"width":8,"height":8,"jpeg":"\#(Self.jpeg8)"}}}"#
            let rest = hub.text(reply)
            let media = (try? JSONSerialization.jsonObject(with: Data(rest.utf8)) as? [String: Any])?["media"] as? [String: Any]
            return ((media?["poster"] as? [String: Any])?["jpeg"] as? String) ?? ""
        }
        let posterA = named("A"), posterB = named("B")
        let shown = Log()
        let renderer = BrowserRenderer(threadId: "B", showPoster: { _ in shown.show(0) }, present: { _ in }, ack: { _ in })
        defer { renderer.close() }
        renderer.follow(hub)
        hub.setDelivery(MediaDelivery(generation: 5, path: nil, revision: 2), for: DeliveryKey(view: "browser", source: "B"))
        // A's reply arrives after the switch: its delivery is A's, never B's.
        hub.setDelivery(MediaDelivery(generation: 3, path: "mc", revision: 3, poster: posterA), for: DeliveryKey(view: "browser", source: "A"))
        // An older update of B naming A's poster, arriving late, changes nothing either.
        renderer.delivery("B", MediaDelivery(generation: 4, path: "mc", revision: 1, poster: posterA))
        try await Task.sleep(for: .milliseconds(100))
        #expect(shown.pictures.isEmpty)
        hub.setDelivery(MediaDelivery(generation: 5, path: "mc", revision: 4, poster: posterB), for: DeliveryKey(view: "browser", source: "B"))
        for _ in 0..<200 where shown.pictures.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        #expect(shown.pictures.count == 1)
    }

    /// An 8 × 8 JPEG, base64.
    private static let jpeg8: String = {
        let context = CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, nil)
        CGImageDestinationFinalize(destination)
        return (data as Data).base64EncodedString()
    }()
}
