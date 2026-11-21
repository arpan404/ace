import CoreGraphics
import CoreVideo
import Foundation

/// A decoded picture, waiting for the screen's next refresh.
struct BrowserPicture: @unchecked Sendable {
    let image: CVPixelBuffer
    let sequence: Int
    /// The page's size in CSS pixels: input coordinates map to it.
    let page: CGSize
    /// The tab this picture shows, as its stream's last keyframe said; nil before one did.
    var tabId: String? = nil
}

/// A cumulative video acknowledgement (`browser.ack` with `video`, ADR 0088).
struct BrowserAck: Equatable, Sendable {
    let sequence: Int
    /// The delivery generation the picture came for (`media.delivery`). The shared script sends it
    /// by that delivery's media connection, or not at all once it is stale.
    var generation: Int? = nil
    /// The decoder lost its place: the daemon sends a keyframe.
    var keyframe = false
    var fallback = false
}

/// One thread's video chunks, decoded off the main thread, from the socket's queue to
/// `present`. Each chunk is acknowledged as soon as the decoder is done with it, whether or not
/// the screen ever shows its picture: a delta with nothing to decode against is acknowledged at
/// once, and a decode error asks for a keyframe. Everything mutable is confined to `queue`.
final class BrowserRenderer: @unchecked Sendable {
    let threadId: String
    private let queue = DispatchQueue(label: "ace.browser.render", qos: .userInteractive)
    private let present: @Sendable (BrowserPicture) -> Void
    private let ack: @Sendable (BrowserAck) -> Void
    private var gate = VideoChunkGate()
    private var decoder: VideoDecoder?
    private var closed = false
    /// The tab the stream shows, from its keyframes (deltas don't repeat it).
    private var tabId: String?
    /// The thread's pictures held to its current delivery (`DeliveryGate`).
    private var delivery = DeliveryGate<BrowserVideoChunk>()
    private let clock: @Sendable () -> TimeInterval
    /// The decoded picture not yet drawn is let go when the delivery starts over.
    private let discard: @Sendable () -> Void
    /// Shows the poster a delivery for this thread names, until the first live picture.
    private let showPoster: @Sendable (CGImage) -> Void
    /// Hears the sentence saying why pictures don't come, or nil once one does.
    private let waiting: @Sendable (String?) -> Void
    private var said: String?
    private let latch = ClosedLatch()
    /// Where this thread's deliveries and the posters they name come from, once following.
    private var hub: BrowserStreamHub?

    init(threadId: String, clock: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         discard: @escaping @Sendable () -> Void = {}, showPoster: @escaping @Sendable (CGImage) -> Void = { _ in },
         waiting: @escaping @Sendable (String?) -> Void = { _ in },
         present: @escaping @Sendable (BrowserPicture) -> Void, ack: @escaping @Sendable (BrowserAck) -> Void) {
        self.threadId = threadId
        self.clock = clock
        self.discard = discard
        self.showPoster = showPoster
        self.waiting = waiting
        self.present = present
        self.ack = ack
    }
    /// From any queue; another thread's chunks are ignored. `path` is the media socket it came by.
    func receive(_ chunk: BrowserVideoChunk, path: String) {
        guard chunk.threadId == threadId else { return }
        queue.async { [self] in
            guard !closed else { return }
            if case .show(let generation) = delivery.arrive(chunk, path: path, at: clock()) {
                tell()
                handle(chunk, generation: generation)
            }
        }
    }
    /// The script set this thread's delivery: a new one starts the decoder over, a settled one
    /// shows what came its way while the reply was pending.
    func delivery(_ source: String, _ next: MediaDelivery) {
        guard source == threadId else { return }
        queue.async { [self] in apply(next) }
    }
    /// Follows this thread's deliveries in `hub`: the registration and the latest one are taken
    /// on this renderer's queue, in order with every update after them.
    func follow(_ hub: BrowserStreamHub?) {
        guard let hub else { return }
        queue.async { [self] in
            guard !latch.isClosed else { return }
            self.hub = hub
            hub.attachDelivery("browser") { [weak self] in self?.delivery($0, $1) }
            if let known = hub.delivery(DeliveryKey(view: "browser", source: threadId)) { apply(known) }
        }
    }
    private func apply(_ next: MediaDelivery) {
        guard !closed else { return }
        let change = delivery.set(next)
        guard change.accepted else { return }
        if change.reset { forget(); discard() }
        for chunk in change.released { handle(chunk, generation: next.generation) }
        if let ask = change.keyframe { ack(BrowserAck(sequence: ask.sequence, generation: next.generation, keyframe: true)) }
        tell()
        // The poster this thread's current subscribe brought back, once its way is settled.
        if next.path != nil, let token = next.poster, let image = hub?.takePoster(token) { showPoster(image) }
    }
    /// The daemon starts this viewer's video again (a new tab, or a resubscribe).
    func reset() { queue.async { [self] in forget() } }
    func close() {
        latch.close()
        queue.async { [self] in closed = true; forget() }
    }

    /// Says the delivery's sentence when it changed.
    private func tell() {
        guard delivery.waiting != said else { return }
        said = delivery.waiting
        waiting(said)
    }
    private func forget() {
        gate.reset()
        decoder = nil
        tabId = nil
    }
    private func handle(_ chunk: BrowserVideoChunk, generation: Int) {
        guard !closed else { return }
        switch gate.admit(chunk) {
        case .skip:
            ack(BrowserAck(sequence: chunk.sequence, generation: generation))
        case .decode(let configure):
            if let configure {
                decoder = nil
                decoder = try? VideoDecoder(config: configure)
            }
            if chunk.key { tabId = chunk.tabId }
            guard let decoder, let image = try? decoder.decode(chunk.bytes) else { return failed(codec: chunk.codec, generation: generation) }
            present(BrowserPicture(image: image, sequence: chunk.sequence, page: CGSize(width: chunk.width, height: chunk.height), tabId: tabId))
            ack(BrowserAck(sequence: chunk.sequence, generation: generation))
        }
    }
    private func failed(codec: String, generation: Int) {
        decoder = nil
        if let sequence = gate.failed() { ack(BrowserAck(sequence: sequence, generation: generation, keyframe: true, fallback: VideoCapabilities.isHEVC(codec))) }
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
