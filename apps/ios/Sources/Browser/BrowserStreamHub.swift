import Foundation

/// Where one runtime's sockets hand decoded browser stream messages, off the JavaScriptCore
/// thread: the live view attaches while it is shown, and nothing is kept while it isn't (the
/// daemon then has no subscriber for this connection and sends none).
final class BrowserStreamHub: @unchecked Sendable {
    private let lock = NSLock()
    private var sink: (@Sendable (BrowserStreamMessage) -> Void)?

    func attach(_ sink: (@Sendable (BrowserStreamMessage) -> Void)?) { lock.withLock { self.sink = sink } }
    /// Called on the delivering socket's queue.
    func deliver(_ message: BrowserStreamMessage) {
        let sink = lock.withLock { self.sink }
        sink?(message)
    }
}

/// One socket's binary messages: stream pieces assembled and decoded natively, anything else
/// handed to the SDK. Confined to the socket's serial delegate queue.
struct BinaryRouter {
    enum Outcome: Equatable {
        /// Waiting for more pieces, or a kind the live view doesn't draw.
        case none
        case stream(BrowserStreamMessage)
        /// Not a stream piece: the SDK's own binary channel reads it.
        case sdk
        /// A malformed piece: the connection is dropped, as the SDK does.
        case broken
    }
    private var assembler = StreamAssembler()

    mutating func route(_ bytes: Data) -> Outcome {
        guard StreamWire.isPiece(bytes) else { return .sdk }
        do {
            guard let envelope = try assembler.push(bytes), let message = try BrowserStreamMessage.decode(envelope) else { return .none }
            return .stream(message)
        } catch {
            assembler.reset()
            return .broken
        }
    }
}
