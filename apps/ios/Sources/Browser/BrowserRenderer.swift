import CoreGraphics
import CoreVideo
import Foundation

/// A decoded picture, waiting for the screen's next refresh.
struct BrowserPicture: @unchecked Sendable {
    let image: CVPixelBuffer
    let sequence: Int
    /// The page's size in CSS pixels: input coordinates map to it.
    let page: CGSize
}

/// A cumulative video acknowledgement (`browser.ack` with `video`, ADR 0088).
struct BrowserAck: Equatable, Sendable {
    let sequence: Int
    /// The decoder lost its place: the daemon sends a keyframe.
    var keyframe = false
}

/// One thread's H.264 chunks, decoded off the main thread, from the socket's queue to
/// `present`. Each chunk is acknowledged as soon as the decoder is done with it, whether or not
/// the screen ever shows its picture: a delta with nothing to decode against is acknowledged at
/// once, and a decode error asks for a keyframe. Everything mutable is confined to `queue`.
final class BrowserRenderer: @unchecked Sendable {
    let threadId: String
    private let queue = DispatchQueue(label: "ace.browser.render", qos: .userInteractive)
    private let present: @Sendable (BrowserPicture) -> Void
    private let ack: @Sendable (BrowserAck) -> Void
    private var gate = VideoChunkGate()
    private var decoder: H264Decoder?
    private var closed = false

    init(threadId: String, present: @escaping @Sendable (BrowserPicture) -> Void, ack: @escaping @Sendable (BrowserAck) -> Void) {
        self.threadId = threadId
        self.present = present
        self.ack = ack
    }
    /// From any queue; another thread's chunks are ignored.
    func receive(_ chunk: BrowserVideoChunk) {
        guard chunk.threadId == threadId else { return }
        queue.async { [self] in handle(chunk) }
    }
    /// The daemon starts this viewer's video again (a new subscription or tab).
    func reset() { queue.async { [self] in forget() } }
    func close() { queue.async { [self] in closed = true; forget() } }

    private func forget() {
        gate.reset()
        decoder = nil
    }
    private func handle(_ chunk: BrowserVideoChunk) {
        guard !closed else { return }
        switch gate.admit(chunk) {
        case .skip:
            ack(BrowserAck(sequence: chunk.sequence))
        case .decode(let configure):
            if let configure {
                decoder = nil
                decoder = try? H264Decoder(config: configure)
            }
            guard let decoder, let image = try? decoder.decode(chunk.bytes) else { return failed() }
            present(BrowserPicture(image: image, sequence: chunk.sequence, page: CGSize(width: chunk.width, height: chunk.height)))
            ack(BrowserAck(sequence: chunk.sequence))
        }
    }
    private func failed() {
        decoder = nil
        if let sequence = gate.failed() { ack(BrowserAck(sequence: sequence, keyframe: true)) }
    }
}

/// The newest decoded picture, handed from the renderer's queue to the display link, which takes
/// it once per refresh: a picture replaced before the next refresh is never drawn.
final class LatestBrowserPicture: @unchecked Sendable {
    private let lock = NSLock()
    private var picture: BrowserPicture?

    func put(_ value: BrowserPicture) { lock.withLock { picture = value } }
    /// The picture put since the last take, if any.
    func take() -> BrowserPicture? {
        lock.withLock {
            let taken = picture
            picture = nil
            return taken
        }
    }
}
