import Foundation
import Security

struct ConnectionTarget: Sendable {
    /// The daemon's socket; a media connection's copy points at ace-media's listener (`media(at:)`).
    private(set) var endpoint: URL
    let hostId: String
    let deviceId: String
    let pin: String?
    /// Keychain key of a paired device token. Its runtime exchanges it for a ticket per attempt.
    let secretKey: String?
    let credential: @Sendable () throws -> String
    /// An account machine (ADR 0111): reached through ace's hosted relay with device grants.
    let relay: RelayRoute?
    /// This app install (ADR 0115), sent in every hello.
    var installId: String?
    /// This install's other device id on the same machine (ADR 0115): a paired machine also on
    /// the account is one device under its pairing's id and its account device's. Sends saved
    /// under either one are this runtime's, so none is lost when the route changes.
    var deviceAliases: [String] = []
    /// An account route to a machine this install also paired: its account hello proves the
    /// pairing (`PairingLinkProof`), so both device ids are one device on the daemon.
    var linkedPairing: LinkedPairing?
    /// The machine this target reaches, as the phone keys it, when that isn't this target's own
    /// host and device: a paired machine reached through its account relay keeps its paired
    /// identity, so it is one machine with one cache and one set of notifications on any route.
    var machineScope: MachineScope?
    var scope: MachineScope { machineScope ?? MachineScope(hostId: hostId, deviceId: deviceId) }

    /// Debug loopback fixture only: a fixed fake credential, never a paired device.
    init(endpoint: URL, hostId: String, deviceId: String, pin: String?, credential: @escaping @Sendable () throws -> String) {
        self.endpoint = endpoint; self.hostId = hostId; self.deviceId = deviceId; self.pin = pin
        self.secretKey = nil; self.credential = credential; self.relay = nil
    }
    /// A paired machine: pinned WSS, pinned HTTPS ticket exchange and a Keychain-held token.
    init(endpoint: URL, hostId: String, deviceId: String, pin: String, secretKey: String) {
        self.endpoint = endpoint; self.hostId = hostId; self.deviceId = deviceId; self.pin = pin
        self.secretKey = secretKey; self.credential = { throw HostError.unsupported }; self.relay = nil
    }
    /// A machine on the phone's ace account: the relay pins the host id itself, so no TLS pin.
    init(relay: RelayRoute, deviceId: String) {
        endpoint = relay.relayURL; hostId = relay.hostId; self.deviceId = deviceId; pin = nil
        secretKey = nil; credential = { throw HostError.unsupported }; self.relay = relay
    }

    /// HTTPS origin of the same daemon listener, for pairing and tickets. None through the relay.
    var httpsOrigin: URL? {
        guard relay == nil, endpoint.scheme == "wss", var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = "https"
        components.path = ""
        return components.url
    }
    func validate() throws {
        guard endpoint.user == nil, endpoint.password == nil, endpoint.query == nil, endpoint.fragment == nil else { throw HostError.transport }
        if let relay { if relay.isValid { return }; throw HostError.transport }
        if endpoint.scheme == "wss", let pin, PinnedTrust.isPin(pin) { return }
        if isLoopbackFixture { return }
        throw HostError.transport
    }
    /// Release builds (no `ACE_FIXTURE`) compile this to false: production requires WSS and an exact pin.
    var isLoopbackFixture: Bool {
        #if ACE_FIXTURE
        endpoint.scheme == "ws" && secretKey == nil && relay == nil && ["127.0.0.1", "localhost", "::1"].contains(endpoint.host ?? "")
        #else
        false
        #endif
    }
}

extension ConnectionTarget {
    /// The same daemon's media listener at `url`, held to this target's rules: WSS with this
    /// target's certificate pin (the daemon hands ace-media its own TLS identity), or plain WS on
    /// loopback in the debug fixture. Nil for any other address, and for a relay target, whose
    /// media stream goes through the relay instead.
    func media(at url: URL) -> ConnectionTarget? {
        guard relay == nil, url.host?.isEmpty == false else { return nil }
        var media = self
        media.endpoint = url
        do { try media.validate() } catch { return nil }
        return media
    }
}

/// The host and device a machine's cache, outbox and notifications are bound to on this phone.
struct MachineScope: Sendable, Equatable { let hostId: String; let deviceId: String }

/// What a socket event carries: text, or a binary message's own bytes.
enum SocketPayload: Sendable { case text(String), bytes(Data) }

/// Callbacks are serial, on its session's queue. The callback transfers owned values back onto
/// the JSC run loop. On its machine's `PinnedSession`, the upgrade can go over a connection the
/// ticket exchange just opened; without one it has a session of its own.
final class PinnedSocket: PinnedTaskHandler, @unchecked Sendable {
    /// From open to the upgrade's answer. A slow link (3G, about 400 ms a round trip) needs
    /// TCP, TLS and the upgrade, under 2 s, with room for two lost SYNs; an address that never
    /// answers then fails in seconds, so the SDK tries its next path or backs off, rather than
    /// holding the machine for URLSession's 60 s. The relay's handshake has the same bound.
    static let connectTimeout: TimeInterval = 10
    private let target: ConnectionTarget
    private let event: @Sendable (String, SocketPayload) -> Void
    /// Browser stream pieces are assembled here, on the session queue, and go to `streams`
    /// without entering JavaScriptCore; other binary messages reach the SDK.
    private let streams: BrowserStreamHub?
    private let session: PinnedSession
    /// A session made for this socket alone ends with it.
    private let ownsSession: Bool
    private var router = BinaryRouter()
    private var task: URLSessionWebSocketTask?
    private var ended = false
    /// The daemon's welcome arrived on this socket (`LaunchTrace` marks the first).
    private var welcomed = false
    private let connectTimeout: TimeInterval
    private var deadline: DispatchWorkItem?
    private var queue: OperationQueue { session.queue }

    init(target: ConnectionTarget, session: PinnedSession? = nil, now: @escaping @Sendable () -> Date = { Date() },
         connectTimeout: TimeInterval = PinnedSocket.connectTimeout,
         streams: BrowserStreamHub? = nil, event: @escaping @Sendable (String, SocketPayload) -> Void) {
        self.target = target
        self.connectTimeout = connectTimeout
        self.event = event
        self.streams = streams
        self.session = session ?? PinnedSession(target: target, now: now)
        ownsSession = session == nil
    }
    func open() {
        do { try target.validate() } catch { event("close", .text("4003")); return }
        queue.addOperation { [self] in
            guard !ended else { return }
            guard let task = session.webSocketTask(target.endpoint, handler: self) else { finish(1006); return }
            task.maximumMessageSize = 2 * 1024 * 1024
            self.task = task
            LaunchTrace.mark("socket.open", target.endpoint.host ?? "")
            // Cancelled once the socket opens or ends, so no stale deadline outlives it.
            let deadline = DispatchWorkItem { [weak self] in
                self?.queue.addOperation { [weak self] in
                    guard let self, !self.ended, self.deadline != nil else { return }
                    self.finish(1006)
                }
            }
            self.deadline = deadline
            DispatchQueue.global().asyncAfter(deadline: .now() + connectTimeout, execute: deadline)
            task.resume()
        }
    }
    func send(_ text: String) {
        queue.addOperation { [weak self] in
            self?.task?.send(.string(text)) { [weak self] error in
                if error != nil { self?.queue.addOperation { [weak self] in self?.finish(1006) } }
            }
        }
    }
    /// One binary message: a media connection's hello. Sent in order with the text ones.
    func send(bytes: Data) {
        queue.addOperation { [weak self] in
            self?.task?.send(.data(bytes)) { [weak self] error in
                if error != nil { self?.queue.addOperation { [weak self] in self?.finish(1006) } }
            }
        }
    }
    func close() {
        queue.addOperation { [weak self] in
            guard let self else { return }
            self.ended = true
            self.end()
        }
    }
    /// Lets the task go, and the session when it is this socket's own.
    private func end() {
        deadline?.cancel()
        deadline = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        if ownsSession { session.close() }
    }
    private func receive() {
        task?.receive { [weak self] result in
            self?.queue.addOperation { [weak self] in
                guard let self, !self.ended else { return }
                switch result {
                case .success(.string(let text)):
                    if !self.welcomed, text.hasPrefix(#"{"type":"welcome""#) { self.welcomed = true; LaunchTrace.mark("socket.welcome") }
                    self.event("message", .text(self.streams?.text(text) ?? text)); self.receive()
                case .success(.data(let bytes)):
                    switch self.router.route(bytes) {
                    case .none: break
                    case .stream(let message): self.streams?.deliver(message)
                    case .device(let message): self.streams?.deliver(message)
                    case .screen(let message): self.streams?.deliverScreen(message)
                    case .sdk: self.event("binary", .bytes(bytes))
                    case .broken: self.finish(1002); return
                    }
                    self.receive()
                case .failure: self.finish(1006)
                @unknown default: self.finish(4002)
                }
            }
        }
    }
    private func finish(_ code: Int, reason: String = "") {
        guard !ended else { return }
        ended = true
        // "<code> <reason>": the reason tells the owner's revocation ("Device revoked") from any other 4003.
        event("close", .text(reason.isEmpty ? String(code) : "\(code) \(reason)"))
        end()
    }
    func opened(_ task: URLSessionWebSocketTask) {
        guard !ended, task === self.task else { return }
        deadline?.cancel()
        deadline = nil
        LaunchTrace.mark("socket.ready")
        event("open", .text(""))
        receive()
    }
    func closed(_ task: URLSessionWebSocketTask, code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(code.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) } ?? "")
    }
    func completed(_ task: URLSessionTask, error: Error?) {
        if error != nil { finish(1006) }
    }
    func refusedTrust(_ task: URLSessionTask) {
        // Report why before the fatal close: 4003 alone also means a revoked device.
        if !ended { event("trust", .text("pin")) }
        finish(4003)
    }
}
