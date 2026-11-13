import Foundation
import os

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
    /// Why each relay connection ended, readable with `log collect` (`app.ace.ios`, `relay`).
    private static let log = Logger(subsystem: "app.ace.ios", category: "relay")

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
    private var deadline: DispatchWorkItem?
    private var opened = Date()
    private var flow = RelayFlow()
    /// Data fragments waiting for the daemon's credit, sealed only when they go out.
    private var waiting: [Data] = []

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
                self?.queue.addOperation { self?.finish(failure == .signedOut ? 4003 : 1006, cause: "no device grant (\(failure))") }
                return
            } catch { self?.queue.addOperation { self?.finish(1006, cause: "no device grant") }; return }
            self?.queue.addOperation { self?.connect(grant: grant) }
        }
        queue.addOperation { [weak self] in
            guard let self else { return }
            self.opened = Date()
            // Cancelled once the channel is secured or ends, so no stale deadline outlives it.
            let deadline = DispatchWorkItem { [weak self] in
                self?.queue.addOperation {
                    guard let self, !self.ended else { return }
                    if case .secured = self.phase { return }
                    self.finish(1006, cause: "handshake timed out")
                }
            }
            self.deadline = deadline
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.handshakeTimeout, execute: deadline)
        }
    }
    private func connect(grant: String) {
        guard !ended, let url = route.clientURL else { finish(4003, cause: "no relay address"); return }
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
            guard let self, !self.ended, case .secured(let channel) = self.phase else { return }
            let message = self.helloSent ? text : Self.offering(text)
            self.helloSent = true
            do {
                self.waiting += try channel.fragments(text: message)
                self.pump()
            } catch { self.finish(1009, cause: "message too large to send") }
        }
    }
    func close() {
        queue.addOperation { [weak self] in
            guard let self else { return }
            if !self.ended { self.record(1000, cause: "closed by the app") }
            self.ended = true
            self.deadline?.cancel()
            self.waiting.removeAll()
            self.task?.cancel(with: .goingAway, reason: nil)
            self.session?.invalidateAndCancel()
            self.task = nil; self.session = nil
            self.phase = .connecting
        }
    }

    /// The first message is the hello: ask for credit-based flow control, so ace's relay never
    /// holds more than a window of the daemon's data for this phone, and say this channel
    /// inflates `deflate-raw`, so the daemon may deflate bulk JSON. Sign-in channels are never
    /// deflated (the daemon ignores it there anyway).
    static func offering(_ text: String) -> String {
        guard var hello = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
              hello["type"] as? String == "hello" else { return text }
        if hello["flowControl"] == nil { hello["flowControl"] = ["credit"] }
        if hello["compression"] == nil, hello["channel"] as? String != "provider_auth" { hello["compression"] = ["deflate-raw"] }
        guard let data = try? JSONSerialization.data(withJSONObject: hello, options: [.withoutEscapingSlashes]) else { return text }
        return String(decoding: data, as: UTF8.self)
    }

    /// The close code of the daemon's `channel.close`, which it writes with `type` first. Pure.
    static func channelClose(_ text: String) -> Int? {
        guard text.hasPrefix(#"{"type":"channel.close""#),
              let value = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
              let code = value["code"] as? Int, (1000...4999).contains(code) else { return nil }
        return code
    }
    /** The reason a `channel.close` gives, so the owner's revocation ("Device revoked") is told from any other 4003. */
    static func channelCloseReason(_ text: String) -> String {
        guard let value = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
              let reason = value["reason"] as? String else { return "" }
        return reason
    }

    private func write(_ frame: Data) {
        task?.send(.data(frame)) { [weak self] error in
            guard let error else { return }
            self?.queue.addOperation { self?.finish(1006, cause: "send failed (\(Self.describe(error)))") }
        }
    }
    /// Seal and write one fragment now: a credit, which never waits for the window.
    private func writeNow(_ plain: Data) throws {
        guard case .secured(var channel) = phase else { return }
        let frame = try channel.seal(plain: plain)
        phase = .secured(channel)
        write(frame)
    }
    /// Send waiting data fragments while the daemon's window has room for them.
    private func pump() {
        guard !ended, case .secured(var channel) = phase else { return }
        do {
            while let next = waiting.first, flow.allows(RelayFlow.cost(next.count)) {
                waiting.removeFirst()
                flow.spend(RelayFlow.cost(next.count))
                write(try channel.seal(plain: next))
            }
            phase = .secured(channel)
        } catch { finish(1002, cause: "seal failed") }
    }
    private func receive() {
        task?.receive { [weak self] result in
            self?.queue.addOperation {
                guard let self, !self.ended else { return }
                switch result {
                case .success(.data(let bytes)): if self.handle(bytes) { self.receive() }
                case .success: self.finish(1002, cause: "relay sent text") // The relay forwards binary only.
                case .failure(let error): self.finish(1006, cause: "receive failed (\(Self.describe(error)))")
                }
            }
        }
    }
    /// One relay message, in order. False once the channel ended.
    private func handle(_ bytes: Data) -> Bool {
        do {
            switch phase {
            case .connecting: finish(1002, cause: "frame before open"); return false
            case .marker(var noise):
                guard bytes == Data([1]) else { finish(1002, cause: "bad pairing marker"); return false }
                write(try noise.writeMessage())
                phase = .responder(noise)
            case .responder(var noise):
                guard try noise.readMessage(bytes).isEmpty else { finish(1002, cause: "bad handshake"); return false }
                write(try noise.writeMessage())
                guard let transport = noise.transport else { finish(1002, cause: "bad handshake"); return false }
                phase = .secured(RelaySession(transport: transport))
                deadline?.cancel()
                LaunchTrace.mark("relay.secured")
                event("open", .text(""))
            case .secured(var channel):
                let received = try channel.receive(bytes)
                phase = .secured(channel)
                switch received {
                case .credit(let amount):
                    if let reply = flow.credited(amount) { try writeNow(reply) }
                    pump()
                case .data(let cost, let message):
                    guard flow.received(cost) else { finish(1002, cause: "daemon overran its flow window"); return false }
                    // A fragment is consumed once handled here: the SDK queue is the phone's own.
                    defer { if !ended, let credit = flow.consumed(cost) { try? writeNow(credit) } }
                    switch message {
                    case nil: break
                    case .text(let text):
                        // The relay has no close frame: the daemon's last message carries the code a
                        // direct socket's close would (4003 revoked, 4008 idle, resync), and it ends here.
                        if let code = Self.channelClose(text) {
                            finish(code, reason: Self.channelCloseReason(text), cause: "daemon closed the channel")
                            return false
                        }
                        event("message", .text(text))
                    case .binary(let data): return deliver(data)
                    }
                }
            }
            return true
        } catch NoiseError.pin {
            // A different machine answered for this host id: nothing was sent to it.
            event("trust", .text("pin"))
            finish(4003, cause: "another machine answered for this host id")
            return false
        } catch {
            finish(1002, cause: "unreadable frame (\(error))")
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
        case .broken: finish(1002, cause: "broken binary message"); return false
        }
        return true
    }
    private func finish(_ code: Int, reason: String = "", cause: String) {
        guard !ended else { return }
        record(code, cause: reason.isEmpty ? cause : "\(cause): \(reason)")
        ended = true
        deadline?.cancel()
        waiting.removeAll()
        phase = .connecting
        event("close", .text(reason.isEmpty ? String(code) : "\(code) \(reason)"))
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
        // 4403 (the machine is on another account) reaches the client as is, which reads it as
        // final. 1008 means the machine isn't connected right now: a drop to retry.
        let said = reason.map { String(decoding: $0.prefix(123), as: UTF8.self) } ?? ""
        finish(closeCode.rawValue == 1008 ? 1006 : closeCode.rawValue,
               cause: "relay closed the socket (\(closeCode.rawValue) \(said))")
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }
        // A 403 before the upgrade is a refusal for good; 401 and 503 retry with a fresh grant.
        let status = (task.response as? HTTPURLResponse)?.statusCode
        finish(status == 403 ? 4003 : 1006,
               cause: "connection failed (\(status.map(String.init) ?? "no response"), \(Self.describe(error)))")
    }

    /// One line in the relay log: the close code the SDK will see, why, and how long it lasted.
    private func record(_ code: Int, cause: String) {
        let seconds = Date().timeIntervalSince(opened)
        var secured = false
        if case .secured = phase { secured = true }
        Self.log.notice("relay closed \(code, privacy: .public) after \(String(format: "%.1f", seconds), privacy: .public)s, \(secured ? "secured" : "before secured", privacy: .public): \(cause, privacy: .public)")
    }
    /// An error as its domain and code: enough to tell a timeout from a reset, and no addresses.
    private static func describe(_ error: Error) -> String {
        let error = error as NSError
        return "\(error.domain) \(error.code)"
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
