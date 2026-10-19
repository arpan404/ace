import CoreGraphics
import CoreMedia
import Foundation
import ImageIO

/// A picture ready for the screen and what to acknowledge once it is there.
struct BrowserPicture: @unchecked Sendable {
    enum Content { case image(CGImage), video(CMSampleBuffer) }
    let content: Content
    let sequence: Int
    /// Video chunks are acknowledged cumulatively; JPEG frames one at a time.
    let video: Bool
    /// The page's size in CSS pixels: input coordinates map to it.
    let page: CGSize
}

/// What the renderer asks the daemon for once a picture can't be shown or was skipped.
struct BrowserAck: Equatable, Sendable {
    let sequence: Int
    let video: Bool
    var keyframe = false
}

/// One thread's pictures, decoded off the main thread: JPEG frames (kind 1) and H.264 chunks
/// (kind 2), from the socket's queue to `present`. A JPEG frame means the daemon's video for this
/// viewer stopped, so the video starts again from its next keyframe. Pictures that can't be
/// decoded are acknowledged at once (a delta with nothing to decode against, a broken JPEG); a
/// decode error asks for a keyframe. Everything mutable is confined to `queue`.
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
    /// From any queue; another thread's messages are ignored.
    func receive(_ message: BrowserStreamMessage) {
        guard message.threadId == threadId else { return }
        queue.async { [self] in handle(message) }
    }
    /// The daemon starts this viewer's pictures again (a new subscription or tab).
    func reset() { queue.async { [self] in forget() } }
    func close() { queue.async { [self] in closed = true; forget() } }

    private func forget() {
        gate.reset()
        decoder = nil
    }
    private func handle(_ message: BrowserStreamMessage) {
        guard !closed else { return }
        switch message {
        case .frame(let frame):
            forget()
            let page = CGSize(width: frame.width, height: frame.height)
            if let image = Self.jpeg(frame.bytes) {
                present(BrowserPicture(content: .image(image), sequence: frame.sequence, video: false, page: page))
            } else {
                // A frame that can't be decoded is skipped; the next one may.
                ack(BrowserAck(sequence: frame.sequence, video: false))
            }
        case .video(let chunk):
            switch gate.admit(chunk) {
            case .skip:
                ack(BrowserAck(sequence: chunk.sequence, video: true))
            case .decode(let configure):
                if let configure {
                    decoder = nil
                    decoder = try? H264Decoder(config: configure)
                }
                guard let decoder, let image = try? decoder.decode(chunk.bytes),
                      let sample = H264Decoder.displayBuffer(image) else { return failed() }
                present(BrowserPicture(content: .video(sample), sequence: chunk.sequence, video: true,
                                       page: CGSize(width: chunk.width, height: chunk.height)))
            }
        }
    }
    private func failed() {
        decoder = nil
        if let sequence = gate.failed() { ack(BrowserAck(sequence: sequence, video: true, keyframe: true)) }
    }
    private static func jpeg(_ bytes: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil) else { return nil }
        // Decoded here, off the main thread, rather than when the layer first draws it.
        return CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    }
}
