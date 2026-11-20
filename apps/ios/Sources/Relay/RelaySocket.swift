import Foundation
import os

/// A runtime's socket to its daemon: the pinned direct socket, or the relay channel.
protocol DaemonSocket: AnyObject, Sendable {
    func open()
    func send(_ text: String)
    /// A binary message: only a direct media connection's hello is one.
    func send(bytes: Data)
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
    /// The relay stream's purpose: nil for the daemon's own channels, `media` for a media
    /// connection, whose stream the daemon hands to ace-media once it has admitted the hello.
    private let purpose: String?
    /// The way this socket's pictures come (`MediaDelivery`): the channel, or the media
    /// connection's own socket id.
    private let path: String
    private let event: @Sendable (String, SocketPayload) -> Void
    private let streams: BrowserStreamHub?
    private let aceClient: String?
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
    /// The grant this connection presented, dropped from the kept ones if it is refused.
    private var grant: String?
    /// The daemon's welcome arrived; until then an `unauthorized` error refuses the grant.
    private var welcomed = false
    /// This connection presented a kept grant rather than one fetched for it.
    private var presentedKept = false
    /// What this dial offers for the first handshake message (ADR 0155); less on each retry.
    private var offer = RelayShortcut.inUpgrade
    /// This dial's upgrade succeeded: a failure after it says nothing of the upgrade's header.
    private var upgraded = false

    private enum Phase {
        case connecting
        /// The upgrade is out. The handshake's first message is written, as it may be in the request.
        case opening(NoiseXX, first: Data)
        /// Waiting for the readiness marker, then sending `pending` if it hasn't gone yet.
        case marker(NoiseXX, pending: Data?)
        case responder(NoiseXX)
        case secured(RelaySession)
    }

    init(route: RelayRoute, purpose: String? = nil, path: String = MediaDelivery.channel, streams: BrowserStreamHub? = nil,
         aceClient: String? = AceCloudRequest.defaultClient,
         keys: @escaping @Sendable () -> (NoiseKeys, NoiseKeys) = { (.generate(), .generate()) },
         event: @escaping @Sendable (String, SocketPayload) -> Void) {
        self.route = route; self.purpose = purpose; self.path = path; self.streams = streams; self.aceClient = aceClient; self.keys = keys; self.event = event
        super.init()
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .userInitiated
    }

    func open() {
        guard route.isValid else { event("close", .text("4003")); return }
        let route = route
        // The kept device grant while it has time left (it also names this device in the
        // hello), so a reconnect opens its socket at once; a new one only when none is kept.
        if let kept = route.grants.kept() {
            queue.addOperation { [weak self] in self?.presentedKept = true; self?.connect(grant: kept) }
        } else {
            Task { [weak self] in
                let grant: String
                do { grant = try await route.grants.fresh() }
                catch let failure as AccountGrantError {
                    self?.queue.addOperation { self?.finish(failure == .signedOut ? 4003 : 1006, cause: "no device grant (\(failure))") }
                    return
                } catch { self?.queue.addOperation { self?.finish(1006, cause: "no device grant") }; return }
                self?.queue.addOperation { self?.connect(grant: grant) }
            }
        }
        queue.addOperation { [weak self] in
            guard let self else { return }
            self.opened = Date()
            // Cancelled once the channel is secured or ends, so no stale deadline outlives it.
            let deadline = DispatchWorkItem { [weak self] in
                self?.queue.addOperation {
                    guard let self, !self.ended else { return }
                    if case .secured = self.phase { return }
                    self.finish(1006, named: "handshake_timeout", cause: "handshake timed out")
                }
            }
            self.deadline = deadline
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.handshakeTimeout, execute: deadline)
        }
    }
    private func connect(grant: String) {
        guard !ended, let url = route.clientURL(purpose: purpose) else { finish(4003, cause: "no relay address"); return }
        self.grant = grant
        let config = URLSessionConfiguration.ephemeral
        config.tlsMinimumSupportedProtocolVersion = .TLSv12
        config.urlCache = nil
        config.httpCookieStorage = nil
        let session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        self.session = session
        let (staticKey, ephemeral) = keys()
        var noise = NoiseXX(initiator: true, staticKey: staticKey, ephemeralKey: ephemeral,
                            prologue: Self.prologue, pinnedFingerprint: route.hostId)
        // `-> e`: the ephemeral public key, which may travel in the upgrade (ADR 0155, step 3).
        guard let first = try? noise.writeMessage() else { finish(1002, cause: "handshake failed"); return }
        phase = .opening(noise, first: first)
        upgraded = false
        // The grant travels as a subprotocol: never in a URL, which logs would keep. Neither it
        // nor the upgrade entry is ever logged.
        let protocols = RelayEarly.protocols(grant: grant, first: first, offer: offer)
        let request = AceCloudRequest.webSocket(url: url, protocols: protocols, client: aceClient)
        let task = session.webSocketTask(with: request)
        Self.prepare(task)
        self.task = task
        LaunchTrace.mark("relay.open", url.host ?? "")
        task.resume()
    }

    /// What URLSession may take as one received message. It counts a message as it arrives, so
    /// one that came through permessage-deflate (which the hosted relay's edge negotiates)
    /// counts compressed: a full Noise frame doesn't compress and arrives a few bytes past
    /// `noiseMaxMessage`, which at that limit failed every receive of one with EMSGSIZE (#1876).
    /// The Noise layer still refuses any frame past `noiseMaxMessage` once it is read.
    static let receiveLimit = noiseMaxMessage + 4096
    static func prepare(_ task: URLSessionWebSocketTask) {
        task.maximumMessageSize = receiveLimit
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
    /// A relay stream's hello is JSON (`channel: "media"` with its ticket), so the script never
    /// sends binary on one: if it did, the stream ends rather than carry something undefined.
    func send(bytes: Data) {
        queue.addOperation { [weak self] in self?.finish(1002, cause: "binary message from the app") }
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
        // ace-media carries a media stream's text after the hand-over, and inflates nothing.
        let plain = ["provider_auth", "media"].contains(hello["channel"] as? String ?? "")
        if hello["compression"] == nil, !plain { hello["compression"] = ["deflate-raw"] }
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
        guard let task else { return }
        task.send(.data(frame)) { [weak self] error in
            guard let error else { return }
            self?.queue.addOperation { [weak self] in
                // A dial this socket already replaced says nothing of the current one.
                guard let self, task === self.task else { return }
                self.finish(1006, named: "send_failed", cause: "send failed (\(Self.describe(error)))")
            }
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
        guard let task else { return }
        task.receive { [weak self] result in
            self?.queue.addOperation { [weak self] in
                guard let self, !self.ended, task === self.task else { return }
                switch result {
                case .success(.data(let bytes)): if self.handle(bytes) { self.receive() }
                case .success: self.finish(1002, cause: "relay sent text") // The relay forwards binary only.
                case .failure(let error):
                    // A close frame ends the receive before its callback: 4020 dials again.
                    if task.closeCode.rawValue == RelayEarly.lostClose, self.redial(closeCode: RelayEarly.lostClose) { return }
                    self.finish(1006, named: Self.failureCause(error) ?? "receive_failed", cause: "receive failed (\(Self.describe(error)))")
                }
            }
        }
    }
    /// One relay message, in order. False once the channel ended.
    private func handle(_ bytes: Data) -> Bool {
        do {
            switch phase {
            case .connecting, .opening: finish(1002, cause: "frame before open"); return false
            case .marker(let noise, let pending):
                guard RelayEarly.isMarker(bytes) else { finish(1002, cause: "bad pairing marker"); return false }
                if let pending { write(pending) }
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
                        if !welcomed, !admission(text) { return false }
                        event("message", .text(streams?.text(text) ?? text))
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
    /// Before the welcome: the daemon either welcomes this device or refuses its hello. A grant
    /// it refused is not presented again. A refused kept grant may only have outlived the
    /// daemon's view of it (clocks that differ near its expiry): the channel drops as a lost
    /// connection instead (1006), so the SDK reconnects once with a newly fetched grant. A
    /// fetched grant refused the same way reaches the SDK as the refusal it is. False once the
    /// channel ended.
    private func admission(_ text: String) -> Bool {
        if text.hasPrefix(#"{"type":"welcome""#) { welcomed = true; LaunchTrace.mark("relay.welcome"); return true }
        guard Self.refusesGrant(text), let grant else { return true }
        route.grants.discard(grant)
        guard presentedKept else { return true }
        finish(1006, cause: "the daemon refused the kept grant; the next connection fetches one")
        return false
    }
    /// The daemon's refusal of a hello's grant: an `error` naming `unauthorized`. Pure.
    static func refusesGrant(_ text: String) -> Bool {
        guard text.hasPrefix(#"{"type":"error""#),
              let value = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return false }
        return value["code"] as? String == "unauthorized"
    }
    private func deliver(_ bytes: Data) -> Bool {
        switch router.route(bytes) {
        case .none: break
        case .stream(let message): streams?.deliver(message, path: path)
        case .device(let message): streams?.deliver(message, path: path)
        case .screen(let message): streams?.deliverScreen(message, path: path)
        case .sdk: event("binary", .bytes(bytes))
        case .broken: finish(1002, cause: "broken binary message"); return false
        }
        return true
    }
    /// `named`: the cause from the daemon's list (`ClientCloseCause`) the SDK reports in its next
    /// hello, for the failures this socket can name; `cause` is only logged on the phone.
    private func finish(_ code: Int, reason: String = "", named: String? = nil, cause: String) {
        guard !ended else { return }
        record(code, cause: reason.isEmpty ? cause : "\(cause): \(reason)")
        ended = true
        deadline?.cancel()
        waiting.removeAll()
        phase = .connecting
        event("close", .text(Self.closeEvent(code, reason: reason, named: named)))
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
        task = nil; session = nil
    }

    /// One more dial at once, offering less, when this one's failure is one a shortcut caused:
    /// an upgrade carrying the message that failed before it opened (a proxy's header limit), or
    /// a held frame the hosted relay lost (4020). Never once the channel is secured. True if it dialled.
    private func redial(closeCode: Int?) -> Bool {
        if case .secured = phase { return false }
        guard !ended, let grant, let next = RelayEarly.retry(after: offer, upgraded: upgraded, closeCode: closeCode) else { return false }
        Self.log.notice("relay dials again \(next == .early ? "without the message in the upgrade" : "without sending early", privacy: .public)")
        offer = next
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
        task = nil; session = nil
        phase = .connecting
        connect(grant: grant)
        return true
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard !ended, webSocketTask === task, case .opening(let noise, let first) = phase else { return }
        upgraded = true
        switch RelayEarly.first(echoed: `protocol`, offer: offer) {
        case .taken: phase = .marker(noise, pending: nil)
        case .now: write(first); phase = .marker(noise, pending: nil)
        case .afterMarker: phase = .marker(noise, pending: first)
        }
        receive()
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task, !redial(closeCode: closeCode.rawValue) else { return }
        // 4403 (the machine is on another account) reaches the client as is, which reads it as
        // final. 1008 means the machine isn't connected right now: a drop to retry.
        let said = reason.map { String(decoding: $0.prefix(123), as: UTF8.self) } ?? ""
        finish(closeCode.rawValue == 1008 ? 1006 : closeCode.rawValue,
               cause: "relay closed the socket (\(closeCode.rawValue) \(said))")
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error, task === self.task else { return }
        // Before the upgrade answer; or a close frame whose callback hasn't come yet.
        let closed = (task as? URLSessionWebSocketTask)?.closeCode.rawValue
        if redial(closeCode: closed == 0 ? nil : closed) { return }
        // A 403 before the upgrade is a refusal for good; 401 and 503 retry with a fresh grant.
        let status = (task.response as? HTTPURLResponse)?.statusCode
        if status == 401, let grant { route.grants.discard(grant) }
        // The same failure may end the task before its receive callback says so.
        finish(status == 403 ? 4003 : 1006, named: Self.failureCause(error),
               cause: "connection failed (\(status.map(String.init) ?? "no response"), \(Self.describe(error)))")
    }

    /// The close event the bridge reads as `<code>` or `<code> <reason>`: the daemon's reason
    /// when it gave one, else `relay:<cause>` when this socket named one. Pure.
    static func closeEvent(_ code: Int, reason: String, named: String?) -> String {
        if !reason.isEmpty { return "\(code) \(reason)" }
        if let named { return "\(code) relay:\(named)" }
        return String(code)
    }
    /// The listed cause a socket failure names on its own: `emsgsize`, a message the socket
    /// refused as too large (#1876). Pure.
    static func failureCause(_ error: Error) -> String? {
        let error = error as NSError
        return error.domain == NSPOSIXErrorDomain && error.code == Int(EMSGSIZE) ? "emsgsize" : nil
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
