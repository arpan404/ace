import Foundation

/// Where one runtime's sockets hand decoded browser video chunks, off the JavaScriptCore
/// thread: the live view attaches while it is shown, and nothing is kept while it isn't (the
/// daemon then has no subscriber for this connection and sends none).
final class BrowserStreamHub: @unchecked Sendable {
    private let lock = NSLock()
    private var sink: (@Sendable (BrowserVideoChunk) -> Void)?
    private var screenSink: (@Sendable (DeviceFrameChunk) -> Void)?
    private var deviceSink: (@Sendable (DeviceFrameChunk) -> Void)?

    func attach(_ sink: (@Sendable (BrowserVideoChunk) -> Void)?) { lock.withLock { self.sink = sink } }
    func attachScreen(_ sink: (@Sendable (DeviceFrameChunk) -> Void)?) { lock.withLock { screenSink = sink } }
    func deliverScreen(_ chunk: DeviceFrameChunk) { lock.withLock { screenSink }?(chunk) }
    func attachDevice(_ sink: (@Sendable (DeviceFrameChunk) -> Void)?) { lock.withLock { deviceSink = sink } }
    func deliver(_ chunk: DeviceFrameChunk) { lock.withLock { deviceSink }?(chunk) }
    /// Called on the delivering socket's queue.
    func deliver(_ chunk: BrowserVideoChunk) {
        let sink = lock.withLock { self.sink }
        sink?(chunk)
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
