import Foundation
import Security

struct ConnectionTarget: Sendable {
    let endpoint: URL
    let hostId: String
    let deviceId: String
    let pin: String?
    /// Keychain key of a paired device token. Its runtime exchanges it for a ticket per attempt.
    let secretKey: String?
    let credential: @Sendable () throws -> String

    /// Debug loopback fixture only: a fixed fake credential, never a paired device.
    init(endpoint: URL, hostId: String, deviceId: String, pin: String?, credential: @escaping @Sendable () throws -> String) {
        self.endpoint = endpoint; self.hostId = hostId; self.deviceId = deviceId; self.pin = pin
        self.secretKey = nil; self.credential = credential
    }
    /// A paired machine: pinned WSS, pinned HTTPS ticket exchange and a Keychain-held token.
    init(endpoint: URL, hostId: String, deviceId: String, pin: String, secretKey: String) {
        self.endpoint = endpoint; self.hostId = hostId; self.deviceId = deviceId; self.pin = pin
        self.secretKey = secretKey; self.credential = { throw HostError.unsupported }
    }

    /// HTTPS origin of the same daemon listener, for pairing and tickets.
    var httpsOrigin: URL? {
        guard endpoint.scheme == "wss", var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = "https"
        components.path = ""
        return components.url
    }
    func validate() throws {
        guard endpoint.user == nil, endpoint.password == nil, endpoint.query == nil, endpoint.fragment == nil else { throw HostError.transport }
        if endpoint.scheme == "wss", let pin, PinnedTrust.isPin(pin) { return }
        if isLoopbackFixture { return }
        throw HostError.transport
    }
    /// Release builds compile this to false: production requires WSS and an exact pin.
    var isLoopbackFixture: Bool {
        #if DEBUG
        endpoint.scheme == "ws" && secretKey == nil && ["127.0.0.1", "localhost", "::1"].contains(endpoint.host ?? "")
        #else
        false
        #endif
    }
}

/// Delegates are serial. The callback transfers owned strings back onto the JSC run loop.
final class PinnedSocket: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let target: ConnectionTarget
    private let event: @Sendable (String, String) -> Void
    private let now: @Sendable () -> Date
    /// Browser stream pieces are assembled here, on the delegate queue, and go to `streams`
    /// without entering JavaScriptCore; other binary messages reach the SDK.
    private let streams: BrowserStreamHub?
    private var router = BinaryRouter()
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var ended = false
    private let queue = OperationQueue()

    init(target: ConnectionTarget, now: @escaping @Sendable () -> Date = { Date() }, streams: BrowserStreamHub? = nil,
         event: @escaping @Sendable (String, String) -> Void) {
        self.target = target
        self.event = event
        self.now = now
        self.streams = streams
        super.init()
        queue.maxConcurrentOperationCount = 1
    }
    func open() {
        do { try target.validate() } catch { event("close", "4003"); return }
        let config = URLSessionConfiguration.ephemeral
        config.tlsMinimumSupportedProtocolVersion = .TLSv12
        config.urlCache = nil
        config.httpCookieStorage = nil
        let session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        self.session = session
        let task = session.webSocketTask(with: target.endpoint)
        task.maximumMessageSize = 2 * 1024 * 1024
        self.task = task
        task.resume()
    }
    func send(_ text: String) {
        queue.addOperation { [weak self] in
            self?.task?.send(.string(text)) { [weak self] error in
                if error != nil { self?.queue.addOperation { [weak self] in self?.finish(1006) } }
            }
        }
    }
    func close() {
        queue.addOperation { [weak self] in
            guard let self else { return }
            self.ended = true
            self.task?.cancel(with: .goingAway, reason: nil)
            self.session?.invalidateAndCancel()
            self.task = nil
            self.session = nil
        }
    }
    private func receive() {
        task?.receive { [weak self] result in
            self?.queue.addOperation { [weak self] in
                guard let self, !self.ended else { return }
                switch result {
                case .success(.string(let text)): self.event("message", text); self.receive()
                case .success(.data(let bytes)):
                    switch self.router.route(bytes) {
                    case .none: break
                    case .stream(let message): self.streams?.deliver(message)
                    case .device(let message): self.streams?.deliver(message)
                    case .sdk: self.event("binary", bytes.base64EncodedString())
                    case .broken: self.finish(1002); return
                    }
                    self.receive()
                case .failure: self.finish(1006)
                @unknown default: self.finish(4002)
                }
            }
        }
    }
    private func finish(_ code: Int) {
        guard !ended else { return }
        ended = true
        event("close", String(code))
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
        task = nil
        session = nil
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard !ended else { return }
        event("open", "")
        receive()
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(closeCode.rawValue)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if error != nil { finish(1006) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        switch PinnedTrust.evaluate(challenge, host: target.endpoint.host, pin: target.pin, now: now()) {
        case .success(let credential): completionHandler(.useCredential, credential)
        case .failure:
            completionHandler(.cancelAuthenticationChallenge, nil)
            // Report why before the fatal close: 4003 alone also means a revoked device.
            if !ended { event("trust", "pin") }
            finish(4003)
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
