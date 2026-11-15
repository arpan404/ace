import Foundation

/// What one task on a `PinnedSession` hears. Every call arrives on the session's serial queue.
protocol PinnedTaskHandler: AnyObject, Sendable {
    /// The server failed the pin or validity check; the connection is being cancelled.
    func refusedTrust(_ task: URLSessionTask)
    /// The server answered with a redirect, which is never followed.
    func redirected(_ task: URLSessionTask)
    func received(_ response: URLResponse, task: URLSessionDataTask) -> URLSession.ResponseDisposition
    func received(_ data: Data, task: URLSessionDataTask)
    func opened(_ task: URLSessionWebSocketTask)
    func closed(_ task: URLSessionWebSocketTask, code: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func completed(_ task: URLSessionTask, error: Error?)
}
extension PinnedTaskHandler {
    func refusedTrust(_ task: URLSessionTask) {}
    func redirected(_ task: URLSessionTask) {}
    func received(_ response: URLResponse, task: URLSessionDataTask) -> URLSession.ResponseDisposition { .cancel }
    func received(_ data: Data, task: URLSessionDataTask) {}
    func opened(_ task: URLSessionWebSocketTask) {}
    func closed(_ task: URLSessionWebSocketTask, code: URLSessionWebSocketTask.CloseCode, reason: Data?) {}
}

/// One machine's pinned HTTPS and WSS, kept for its runtime's life: the ticket exchange and the
/// socket after it share open connections and TLS sessions instead of a new TCP and TLS
/// handshake for each. The pin and validity are checked on every TLS handshake the session
/// makes (`PinnedTrust.evaluate`); a connection the session reuses or resumes was set up by one
/// of those, and a resumed TLS session needs keys only that pinned server holds.
final class PinnedSession: NSObject, URLSessionDataDelegate, URLSessionWebSocketDelegate, @unchecked Sendable {
    /// Every delegate callback, and the state each handler keeps, is on this queue.
    let queue = OperationQueue()
    /// The host and pin every connection is checked against.
    let host: String?
    let pin: String?
    private let now: @Sendable () -> Date
    private let lock = NSLock()
    /// Guarded by `lock`: tasks are registered before they resume, from any thread.
    private var handlers: [Int: any PinnedTaskHandler] = [:]
    private var session: URLSession?
    private var ended = false

    init(host: String?, pin: String?, now: @escaping @Sendable () -> Date = { Date() }) {
        self.host = host; self.pin = pin; self.now = now
        super.init()
        queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .userInitiated
    }
    convenience init(target: ConnectionTarget, now: @escaping @Sendable () -> Date = { Date() }) {
        self.init(host: target.endpoint.host, pin: target.pin, now: now)
    }

    /// Nothing is cached, stored or waited for: the SDK owns retries and its own backoff, and a
    /// request on a network that can't reach the machine should fail now rather than sit
    /// until some network can (`waitsForConnectivity` off). The phone's network monitor wakes
    /// the SDK when a network returns or changes, so nothing waits inside URLSession unseen.
    private static func configuration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.tlsMinimumSupportedProtocolVersion = .TLSv12
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.waitsForConnectivity = false
        config.httpShouldUsePipelining = false
        return config
    }

    /// A task on the session, its callbacks going to `handler`. Nil once the session is closed.
    func dataTask(_ request: URLRequest, handler: any PinnedTaskHandler) -> URLSessionDataTask? {
        lock.withLock {
            guard let session = current() else { return nil }
            let task = session.dataTask(with: request)
            handlers[task.taskIdentifier] = handler
            return task
        }
    }
    func webSocketTask(_ url: URL, handler: any PinnedTaskHandler) -> URLSessionWebSocketTask? {
        lock.withLock {
            guard let session = current() else { return nil }
            let task = session.webSocketTask(with: url)
            handlers[task.taskIdentifier] = handler
            return task
        }
    }
    /// Under `lock`.
    private func current() -> URLSession? {
        if ended { return nil }
        if let session { return session }
        let made = URLSession(configuration: Self.configuration(), delegate: self, delegateQueue: queue)
        session = made
        return made
    }
    /// Cancels every task and drops the connections. Used when the runtime ends.
    func close() {
        let session = lock.withLock {
            ended = true
            defer { self.session = nil }
            return self.session
        }
        session?.invalidateAndCancel()
    }

    private func handler(_ task: URLSessionTask) -> (any PinnedTaskHandler)? {
        lock.withLock { handlers[task.taskIdentifier] }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        switch PinnedTrust.evaluate(challenge, host: host, pin: pin, now: now()) {
        case .success(let credential): completionHandler(.useCredential, credential)
        case .failure:
            handler(task)?.refusedTrust(task)
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
        handler(task)?.redirected(task)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        completionHandler(handler(dataTask)?.received(response, task: dataTask) ?? .cancel)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        handler(dataTask)?.received(data, task: dataTask)
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        handler(webSocketTask)?.opened(webSocketTask)
    }
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        handler(webSocketTask)?.closed(webSocketTask, code: closeCode, reason: reason)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let done = lock.withLock { handlers.removeValue(forKey: task.taskIdentifier) }
        done?.completed(task, error: error)
    }
}
