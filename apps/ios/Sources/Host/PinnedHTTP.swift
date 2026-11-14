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
/// It runs on its machine's `PinnedSession`, so it reuses a connection that session holds open.
final class PinnedHTTP: PinnedTaskHandler, @unchecked Sendable {
    static let maximumResponse = 1_048_576
    private let completion: @Sendable (Result<PinnedHTTPResponse, PinnedHTTPError>) -> Void
    /// Every field below is read and written on the session's queue only.
    private var status = 0
    private var data = Data()
    private var failure: PinnedHTTPError?
    private var finished = false

    private init(completion: @escaping @Sendable (Result<PinnedHTTPResponse, PinnedHTTPError>) -> Void) {
        self.completion = completion
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

    /// One request on a session of its own, for a caller with no machine session (pairing).
    static func send(origin: URL, pin: String?, request: PinnedHTTPRequest, timeout: TimeInterval = 15,
                     now: @escaping @Sendable () -> Date = { Date() },
                     completion: @escaping @Sendable (Result<PinnedHTTPResponse, PinnedHTTPError>) -> Void) {
        let session = PinnedSession(host: origin.host, pin: pin, now: now)
        send(on: session, origin: origin, request: request, timeout: timeout) { result in
            session.close()
            completion(result)
        }
    }
    /// One request on `session`, which must be pinned to `origin`'s host. No answer within
    /// `timeout` of silence, or `timeout` plus five seconds in all, is `.offline`.
    static func send(on session: PinnedSession, origin: URL, request: PinnedHTTPRequest, timeout: TimeInterval = 15,
                     completion: @escaping @Sendable (Result<PinnedHTTPResponse, PinnedHTTPError>) -> Void) {
        let built: URLRequest
        do throws(PinnedHTTPError) {
            guard let pin = session.pin, PinnedTrust.isPin(pin), session.host == origin.host else { throw .invalid }
            built = try urlRequest(origin: origin, request, timeout: timeout)
        } catch { completion(.failure(error)); return }
        let exchange = PinnedHTTP(completion: completion)
        guard let task = session.dataTask(built, handler: exchange) else { completion(.failure(.offline)); return }
        task.resume()
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout + 5) { [weak task] in
            session.queue.addOperation { if !exchange.finished { task?.cancel() } }
        }
    }

    private func finish(_ result: Result<PinnedHTTPResponse, PinnedHTTPError>) {
        guard !finished else { return }
        finished = true
        data = Data()
        completion(result)
    }
    func refusedTrust(_ task: URLSessionTask) { failure = .pin }
    func redirected(_ task: URLSessionTask) {
        failure = .redirect
        task.cancel()
    }
    func received(_ response: URLResponse, task: URLSessionDataTask) -> URLSession.ResponseDisposition {
        guard let http = response as? HTTPURLResponse else { failure = .invalid; return .cancel }
        if (300..<400).contains(http.statusCode) { failure = .redirect; return .cancel }
        if response.expectedContentLength > Int64(Self.maximumResponse) { failure = .limit; return .cancel }
        status = http.statusCode
        return .allow
    }
    func received(_ chunk: Data, task: URLSessionDataTask) {
        guard failure == nil else { return }
        if data.count + chunk.count > Self.maximumResponse { failure = .limit; task.cancel(); return }
        data.append(chunk)
    }
    func completed(_ task: URLSessionTask, error: Error?) {
        if let failure { finish(.failure(failure)); return }
        guard error == nil, status != 0 else { finish(.failure(.offline)); return }
        guard let body = String(data: data, encoding: .utf8) else { finish(.failure(.invalid)); return }
        finish(.success(PinnedHTTPResponse(status: status, body: body)))
    }
}
