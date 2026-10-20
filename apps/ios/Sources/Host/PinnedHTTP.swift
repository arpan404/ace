import Foundation

/// Refusals reported to the bridge instead of a response. Raw values are the wire contract.
enum PinnedHTTPError: String, Error, Sendable { case pin, redirect, offline, limit, invalid }

struct PinnedHTTPRequest: Decodable, Sendable {
    let method: String
    let path: String
    let body: String?
    let token: String?
}
struct PinnedHTTPResponse: Codable, Sendable, Equatable { let status: Int; let body: String }

/// One request over HTTPS whose server must present the pinned public key. Credentials are
/// written only after the pin and validity check pass; redirects are refused, never followed.
final class PinnedHTTP: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let maximumResponse = 1_048_576
    private let pin: String
    private let host: String?
    private let now: @Sendable () -> Date
    private let completion: @Sendable (Result<PinnedHTTPResponse, PinnedHTTPError>) -> Void
    private let queue = OperationQueue()
    private var status = 0
    private var data = Data()
    private var failure: PinnedHTTPError?
    private var finished = false

    private init(host: String?, pin: String, now: @escaping @Sendable () -> Date,
                 completion: @escaping @Sendable (Result<PinnedHTTPResponse, PinnedHTTPError>) -> Void) {
        self.host = host; self.pin = pin; self.now = now; self.completion = completion
        super.init()
        queue.maxConcurrentOperationCount = 1
    }

    /// The request URL is `origin` plus a fixed `/v1/` path; nothing from the pairing fragment.
    static func urlRequest(origin: URL, _ request: PinnedHTTPRequest, timeout: TimeInterval) throws(PinnedHTTPError) -> URLRequest {
        guard origin.scheme == "https", origin.user == nil, origin.password == nil, origin.query == nil,
              origin.fragment == nil, origin.path.isEmpty || origin.path == "/",
              ["GET", "POST"].contains(request.method),
              request.path.hasPrefix("/v1/"), request.path.utf8.count <= 256,
              request.path.unicodeScalars.allSatisfy({ CharacterSet.urlPathAllowed.contains($0) }),
              !request.path.contains(".."), (request.body?.utf8.count ?? 0) <= 4096,
              var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { throw .invalid }
        components.path = request.path
        guard let url = components.url else { throw .invalid }
        var value = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
        value.httpMethod = request.method
        value.httpShouldHandleCookies = false
        value.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let token = request.token {
            guard PinnedTrust.isPin(token) else { throw .invalid } // Device tokens are 64 lowercase hex.
            value.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body = request.body {
            value.httpBody = Data(body.utf8)
            value.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return value
    }

    static func send(origin: URL, pin: String?, request: PinnedHTTPRequest, timeout: TimeInterval = 15,
                     now: @escaping @Sendable () -> Date = { Date() },
                     completion: @escaping @Sendable (Result<PinnedHTTPResponse, PinnedHTTPError>) -> Void) {
        let built: URLRequest
        do throws(PinnedHTTPError) {
            guard let pin, PinnedTrust.isPin(pin) else { throw .invalid }
            built = try urlRequest(origin: origin, request, timeout: timeout)
        } catch { completion(.failure(error)); return }
        let exchange = PinnedHTTP(host: origin.host, pin: pin ?? "", now: now, completion: completion)
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout + 5
        config.waitsForConnectivity = false
        let session = URLSession(configuration: config, delegate: exchange, delegateQueue: exchange.queue)
        session.dataTask(with: built).resume()
        session.finishTasksAndInvalidate()
    }

    private func finish(_ result: Result<PinnedHTTPResponse, PinnedHTTPError>) {
        guard !finished else { return }
        finished = true
        data = Data()
        completion(result)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        switch PinnedTrust.evaluate(challenge, host: host, pin: pin, now: now()) {
        case .success(let credential): completionHandler(.useCredential, credential)
        case .failure:
            failure = .pin
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        failure = .redirect
        completionHandler(nil)
        task.cancel()
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else { failure = .invalid; completionHandler(.cancel); return }
        if (300..<400).contains(http.statusCode) { failure = .redirect; completionHandler(.cancel); return }
        if response.expectedContentLength > Int64(Self.maximumResponse) { failure = .limit; completionHandler(.cancel); return }
        status = http.statusCode
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        guard failure == nil else { return }
        if data.count + chunk.count > Self.maximumResponse { failure = .limit; dataTask.cancel(); return }
        data.append(chunk)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let failure { finish(.failure(failure)); return }
        guard error == nil, status != 0 else { finish(.failure(.offline)); return }
        guard let body = String(data: data, encoding: .utf8) else { finish(.failure(.invalid)); return }
        finish(.success(PinnedHTTPResponse(status: status, body: body)))
    }
}
