import CoreGraphics
import Foundation

/// Where one runtime's media sockets hand decoded live pictures, off the JavaScriptCore thread:
/// the live view attaches while it is shown, and nothing is kept while it isn't (the daemon then
/// has no subscriber for this connection and sends none).
final class BrowserStreamHub: @unchecked Sendable {
    /// A picture and the media socket it came by.
    typealias Sink<Picture> = @Sendable (Picture, String) -> Void
    private let lock = NSLock()
    private var sink: Sink<BrowserVideoChunk>?
    private var screenSink: Sink<DeviceFrameChunk>?
    private var deviceSink: Sink<DeviceFrameChunk>?
    /// Posters from subscribe replies by the token that names them there, the newest few, until
    /// the script's delivery for their source and generation asks for one (`takePoster`).
    private var posters: [(token: String, image: CGImage)] = []
    private var posterCount = 0
    /// Each source's latest delivery as the script set it, and the open view that follows it.
    private var deliveries: [DeliveryKey: MediaDelivery] = [:]
    private var deliverySinks: [String: @Sendable (String, MediaDelivery) -> Void] = [:]

    func attach(_ sink: Sink<BrowserVideoChunk>?) { lock.withLock { self.sink = sink } }
    func attachScreen(_ sink: Sink<DeviceFrameChunk>?) { lock.withLock { screenSink = sink } }
    func deliverScreen(_ chunk: DeviceFrameChunk, path: String) { lock.withLock { screenSink }?(chunk, path) }
    func attachDevice(_ sink: Sink<DeviceFrameChunk>?) { lock.withLock { deviceSink = sink } }
    func deliver(_ chunk: DeviceFrameChunk, path: String) { lock.withLock { deviceSink }?(chunk, path) }
    /// Called on the delivering socket's queue.
    func deliver(_ chunk: BrowserVideoChunk, path: String) { lock.withLock { sink }?(chunk, path) }

    /// `view`'s open renderer follows its sources' deliveries from now on; nil when it closes.
    func attachDelivery(_ view: String, _ sink: (@Sendable (String, MediaDelivery) -> Void)?) {
        lock.withLock { deliverySinks[view] = sink }
    }
    /// The script set a source's delivery (`media.delivery`).
    func setDelivery(_ delivery: MediaDelivery, for key: DeliveryKey) {
        let sink = lock.withLock { () -> (@Sendable (String, MediaDelivery) -> Void)? in
            deliveries[key] = delivery
            if deliveries.count > 256 { deliveries.removeAll(); deliveries[key] = delivery }
            return deliverySinks[key.view]
        }
        sink?(key.source, delivery)
    }
    /// A source's latest delivery, for a renderer that opens after it was set.
    func delivery(_ key: DeliveryKey) -> MediaDelivery? { lock.withLock { deliveries[key] } }

    /// A text message from a socket: a subscribe reply's poster is decoded here and kept under a
    /// token that takes its JPEG's place in the reply, so the script can say which subscribe it
    /// belongs to without the picture entering it. Called on the delivering socket's queue.
    func text(_ message: String) -> String {
        let token = lock.withLock { posterCount += 1; return "ace-poster-\(posterCount)" }
        let (rest, taken) = PosterReply.take(message, token: token)
        if let taken, let image = PosterReply.decode(taken) {
            lock.withLock {
                posters.append((token, image))
                if posters.count > 8 { posters.removeFirst() }
            }
        }
        return rest
    }
    /// The poster named `token`, once: the script's delivery for its subscribe asked for it.
    func takePoster(_ token: String) -> CGImage? {
        lock.withLock {
            guard let index = posters.firstIndex(where: { $0.token == token }) else { return nil }
            return posters.remove(at: index).image
        }
    }
}

/// One socket's binary messages: stream pieces assembled and decoded natively, anything else
/// handed to the SDK. Confined to the socket's serial delegate queue.
struct BinaryRouter {
    enum Outcome: Equatable {
        /// Waiting for more pieces, or a kind the live view doesn't draw (JPEG frames among them).
        case none
        case stream(BrowserVideoChunk)
        /// A simulator's or emulator's picture (kind 4), on the devices channel.
        case device(DeviceFrameChunk)
        case screen(DeviceFrameChunk)
        /// Not a picture: the SDK's own binary channel reads it (a download's pieces too).
        case sdk
        /// A malformed piece: the connection is dropped, as the SDK does.
        case broken
    }
    private var assembler = StreamAssembler()

    mutating func route(_ bytes: Data) -> Outcome {
        guard StreamWire.isPiece(bytes) else { return .sdk }
        // A download's bytes belong to the SDK's transfer (`fetchBrowserDownload`), which
        // assembles its own pieces; they never interleave with a picture's.
        if ByteReader(bytes).u8(5) == StreamWire.Kind.download { return .sdk }
        do {
            guard let envelope = try assembler.push(bytes) else { return .none }
            if envelope.kind == StreamWire.Kind.screenFrame { return .screen(try DeviceFrameChunk.decodeScreen(envelope.meta, envelope.payload)) }
            if envelope.kind == StreamWire.Kind.deviceFrame { return .device(try DeviceFrameChunk.decode(envelope.meta, envelope.payload)) }
            guard let chunk = try BrowserVideoChunk.decode(envelope) else { return .none }
            return .stream(chunk)
        } catch {
            assembler.reset()
            return .broken
        }
    }
}
