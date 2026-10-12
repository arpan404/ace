import Foundation
import Security

struct ConnectionTarget: Sendable {
    let endpoint: URL
    let hostId: String
    let deviceId: String
    let pin: String?
    let credential: @Sendable () throws -> String

    func validate() throws {
        guard endpoint.user == nil, endpoint.password == nil, endpoint.query == nil, endpoint.fragment == nil else { throw HostError.transport }
        if endpoint.scheme == "wss", let pin, pin.count == 64, pin.allSatisfy({ $0.isHexDigit }) { return }
        #if DEBUG
        if endpoint.scheme == "ws", ["127.0.0.1", "localhost", "::1"].contains(endpoint.host ?? "") { return }
        #endif
        throw HostError.transport
    }
}

/// Delegates are serial. The callback transfers owned strings back onto the JSC run loop.
final class PinnedSocket: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let target: ConnectionTarget
    private let event: @Sendable (String, String) -> Void
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var ended = false
    private let queue = OperationQueue()

    init(target: ConnectionTarget, event: @escaping @Sendable (String, String) -> Void) {
        self.target = target
        self.event = event
        super.init()
        queue.maxConcurrentOperationCount = 1
    }
    func open() {
        do { try target.validate() } catch { event("close", "4003"); return }
        let config = URLSessionConfiguration.ephemeral
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
                    if let text = String(data: bytes, encoding: .utf8) { self.event("message", text); self.receive() }
                    else { self.finish(4002) }
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
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == target.endpoint.host,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
              let actual = try? CertificatePin.digest(certificate: SecCertificateCopyData(leaf) as Data),
              actual == target.pin?.lowercased() else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            finish(4003)
            return
        }
        // A QR-confirmed exact public key authenticates the daemon's self-signed certificate.
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
