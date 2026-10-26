import Foundation

/// A connection the socket server hands out and may close.
public protocol LockedUseServedConnection: AnyObject {
    func start()
    func closeAsync()
}

extension LockedUseFramedConnection: LockedUseServedConnection {}

/// One daemon connection that serves nothing until the peer proves it holds the daemon's
/// token. The first frame must be a valid hello (see `lockedUseCheckHello`) and must arrive
/// within `handshakeTimeout`; otherwise the connection closes and no request is delivered.
/// Outbound messages are dropped until the hello is accepted.
public final class LockedUseDaemonLink: LockedUseServedConnection, @unchecked Sendable {
    public typealias After = (_ delay: DispatchTimeInterval, _ queue: DispatchQueue, _ body: @escaping () -> Void) -> Void

    private let queue: DispatchQueue
    private let token: LockedUseDaemonToken
    private let handshakeTimeout: DispatchTimeInterval
    private let after: After
    private let onAuthenticated: (LockedUseDaemonLink) -> Void
    private let onRequest: (Data) -> Void
    private let onClose: (_ wasAuthenticated: Bool) -> Void
    private var connection: LockedUseFramedConnection!
    /// Read and written only on `queue`.
    private var authenticated = false
    private var rejected = false

    /// `onRequest` gets each request frame after a successful hello, on `queue`.
    /// `onClose(wasAuthenticated)` runs once, on `queue`. The owner keeps the link alive
    /// until then.
    public init(fd: Int32, queue: DispatchQueue, token: LockedUseDaemonToken,
                handshakeTimeout: DispatchTimeInterval = .seconds(2),
                after: @escaping After = { delay, queue, body in queue.asyncAfter(deadline: .now() + delay, execute: body) },
                onAuthenticated: @escaping (LockedUseDaemonLink) -> Void = { _ in },
                onRequest: @escaping (Data) -> Void, onClose: @escaping (_ wasAuthenticated: Bool) -> Void) {
        self.queue = queue
        self.token = token
        self.handshakeTimeout = handshakeTimeout
        self.after = after
        self.onAuthenticated = onAuthenticated
        self.onRequest = onRequest
        self.onClose = onClose
        connection = LockedUseFramedConnection(fd: fd, queue: queue,
            onFrame: { [weak self] in self?.receive($0) },
            onClose: { [weak self] in if let self { self.onClose(authenticated) } })
    }

    public func start() {
        connection.start()
        // A peer that connects and stays silent must not hold the only daemon slot.
        after(handshakeTimeout, queue) { [weak self] in
            guard let self, !authenticated else { return }
            connection.close()
        }
    }

    public func send(_ payload: Data) {
        queue.async { [self] in
            guard authenticated else { return }
            connection.send(payload)
        }
    }

    public func closeAsync() { connection.closeAsync() }

    private func receive(_ frame: Data) {
        guard !rejected else { return }
        guard !authenticated else { return onRequest(frame) }
        switch lockedUseCheckHello(frame, token: token) {
        case .accepted(let reply):
            authenticated = true
            if let data = try? reply.encoded() { connection.send(data) }
            onAuthenticated(self)
        case .rejected(let message):
            rejected = true
            if let data = try? message.encoded() { connection.send(data) }
            connection.closeAsync()
        }
    }
}
