import Foundation

/// A runtime's socket to its daemon: the pinned direct socket, or the relay channel.
protocol DaemonSocket: AnyObject, Sendable {
    func open()
    func send(_ text: String)
    func close()
}
extension PinnedSocket: DaemonSocket {}

/// The daemon behind ace's hosted relay (ADR 0111): Noise XX over `/client?hostId=…`, pinned to
/// the host id. Above it the SDK sees the same events as over `PinnedSocket`: `open` once the
/// channel is encrypted, then JSON text and binary messages, then `close` with a code.
final class RelaySocket: NSObject, DaemonSocket, URLSessionWebSocketDelegate, @unchecked Sendable {
    private static let prologue = Data("ace daemon relay stream v1".utf8)
    private static let handshakeTimeout: TimeInterval = 10

    private let route: RelayRoute
    private let event: @Sendable (String, SocketPayload) -> Void
    private let streams: BrowserStreamHub?
    private let keys: @Sendable () -> (NoiseKeys, NoiseKeys)
    /// Every field below is read and written on `queue` only.
    private let queue = OperationQueue()
    private var router = BinaryRouter()
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var phase = Phase.connecting
    private var helloSent = false
    private var ended = false

    private enum Phase {
        case connecting
        case marker(NoiseXX)
        case responder(NoiseXX)
        case secured(RelaySession)
    }

    init(route: RelayRoute, streams: BrowserStreamHub? = nil,
         keys: @escaping @Sendable () -> (NoiseKeys, NoiseKeys) = { (.generate(), .generate()) },
         event: @escaping @Sendable (String, SocketPayload) -> Void) {
        self.route = route; self.streams = streams; self.keys = keys; self.event = event
        super.init()
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .userInitiated
    }

    func open() {
        guard route.isValid else { event("close", .text("4003")); return }
        let route = route
        // A fresh device grant for every relay connection; it also names this device in the hello.
        Task { [weak self] in
            let grant: String
            do { grant = try await route.grants.fresh() }
            catch let failure as AccountGrantError {
                self?.queue.addOperation { self?.finish(failure == .signedOut ? 4003 : 1006) }
                return
            } catch { self?.queue.addOperation { self?.finish(1006) }; return }
            self?.queue.addOperation { self?.connect(grant: grant) }
        }
        queue.addOperation { [weak self] in
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.handshakeTimeout) {
                self?.queue.addOperation {
                    guard let self, !self.ended else { return }
                    if case .secured = self.phase { return }
                    self.finish(1006)
                }
            }
        }
    }
    private func connect(grant: String) {
        guard !ended, let url = route.clientURL else { finish(4003); return }
        let config = URLSessionConfiguration.ephemeral
        config.tlsMinimumSupportedProtocolVersion = .TLSv12
        config.urlCache = nil
        config.httpCookieStorage = nil
        let session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        self.session = session
        // The grant travels as a subprotocol: never in a URL, which logs would keep.
        let task = session.webSocketTask(with: url, protocols: [RelayRoute.grantPrefix + grant])
        task.maximumMessageSize = noiseMaxMessage
        self.task = task
        LaunchTrace.mark("relay.open", url.host ?? "")
        task.resume()
    }

    func send(_ text: String) {
        queue.addOperation { [weak self] in
            guard let self, !self.ended, case .secured(var channel) = self.phase else { return }
            let message = self.helloSent ? text : Self.offeringCompression(text)
            self.helloSent = true
            do {
                let frames = try channel.seal(text: message)
                self.phase = .secured(channel)
                for frame in frames { self.write(frame) }
            } catch { self.finish(1009) }
        }
    }
    func close() {
        queue.addOperation { [weak self] in
            guard let self else { return }
            self.ended = true
            self.task?.cancel(with: .goingAway, reason: nil)
            self.session?.invalidateAndCancel()
            self.task = nil; self.session = nil
            self.phase = .connecting
        }
    }

    /// The first message is the hello: say this channel inflates `deflate-raw`, so the daemon
    /// may deflate bulk JSON. Sign-in channels never are (the daemon ignores it there anyway).
    static func offeringCompression(_ text: String) -> String {
        guard var hello = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
              hello["type"] as? String == "hello", hello["compression"] == nil,
              hello["channel"] as? String != "provider_auth" else { return text }
        hello["compression"] = ["deflate-raw"]
        guard let data = try? JSONSerialization.data(withJSONObject: hello, options: [.withoutEscapingSlashes]) else { return text }
        return String(decoding: data, as: UTF8.self)
    }

    private func write(_ frame: Data) {
        task?.send(.data(frame)) { [weak self] error in
            if error != nil { self?.queue.addOperation { self?.finish(1006) } }
        }
    }
    private func receive() {
        task?.receive { [weak self] result in
            self?.queue.addOperation {
                guard let self, !self.ended else { return }
                switch result {
                case .success(.data(let bytes)): if self.handle(bytes) { self.receive() }
                case .success: self.finish(1002) // The relay forwards binary only.
                case .failure: self.finish(1006)
                }
            }
        }
    }
    /// One relay message, in order. False once the channel ended.
    private func handle(_ bytes: Data) -> Bool {
        do {
            switch phase {
            case .connecting: finish(1002); return false
            case .marker(var noise):
                guard bytes == Data([1]) else { finish(1002); return false }
                write(try noise.writeMessage())
                phase = .responder(noise)
            case .responder(var noise):
                guard try noise.readMessage(bytes).isEmpty else { finish(1002); return false }
                write(try noise.writeMessage())
                guard let transport = noise.transport else { finish(1002); return false }
                phase = .secured(RelaySession(transport: transport))
                LaunchTrace.mark("relay.secured")
                event("open", .text(""))
            case .secured(var channel):
                let message = try channel.open(bytes)
                phase = .secured(channel)
                switch message {
                case nil: break
                case .text(let text): event("message", .text(text))
                case .binary(let data): return deliver(data)
                }
            }
            return true
        } catch NoiseError.pin {
            // A different machine answered for this host id: nothing was sent to it.
            event("trust", .text("pin"))
            finish(4003)
            return false
        } catch {
            finish(1002)
            return false
        }
    }
    private func deliver(_ bytes: Data) -> Bool {
        switch router.route(bytes) {
        case .none: break
        case .stream(let message): streams?.deliver(message)
        case .device(let message): streams?.deliver(message)
        case .screen(let message): streams?.deliverScreen(message)
        case .sdk: event("binary", .bytes(bytes))
        case .broken: finish(1002); return false
        }
        return true
    }
    private func finish(_ code: Int) {
        guard !ended else { return }
        ended = true
        phase = .connecting
        event("close", .text(String(code)))
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
        task = nil; session = nil
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard !ended else { return }
        let (staticKey, ephemeral) = keys()
        phase = .marker(NoiseXX(initiator: true, staticKey: staticKey, ephemeralKey: ephemeral,
                                prologue: Self.prologue, pinnedFingerprint: route.hostId))
        receive()
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        // 1008: the relay refused this device for this machine (another account, or gone).
        finish(closeCode.rawValue == 1008 ? 4003 : closeCode.rawValue)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard error != nil else { return }
        // A 403 before the upgrade is a refusal for good; 401 and 503 retry with a fresh grant.
        let status = (task.response as? HTTPURLResponse)?.statusCode
        finish(status == 403 ? 4003 : 1006)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
