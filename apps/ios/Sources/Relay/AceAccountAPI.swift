import Foundation

/// A machine signed in to the account, as `GET /v1/machines` lists it.
struct AceMachine: Codable, Sendable, Equatable, Identifiable {
    let hostId: String
    let name: String
    let platform: String
    let lastSeenAt: Double
    var id: String { hostId }
}
struct AceGrant: Decodable, Sendable {
    let token: String
    let expiresAt: Double
}
enum AccountGrantError: Error, Equatable {
    /// No session, or the backend no longer knows it: sign in again.
    case signedOut
    /// The backend refused the request for another reason.
    case refused
    /// Network trouble or a 5xx: retry later.
    case unavailable
}

/// The ace account backend's HTTP API (`packages/client/src/ace-account.ts`). It never reaches a
/// paired daemon or a provider. Redirects are refused and responses are bounded.
struct AceAccountAPI: Sendable {
    let origin: URL
    private let http: URLSession

    init(origin: URL) {
        self.origin = origin
        http = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
    }

    /// The origin `AceAccountURL` names in Info.plist: HTTPS, or HTTP on loopback for development.
    static func origin(from value: String?) -> URL? {
        guard let value, let url = URL(string: value), url.host != nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/" else { return nil }
        let loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].contains(url.host ?? "")
        guard url.scheme == "https" || (url.scheme == "http" && loopback) else { return nil }
        return url
    }
    /// ace's hosted relay is served from the account's own domain (docs/relay/accounts.md).
    var relayURL: URL? {
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = ""
        return components.url
    }

    /// A five-minute `device` grant naming this phone.
    func grant(token: String, deviceId: String) async throws(AccountGrantError) -> AceGrant {
        let body = try? JSONEncoder().encode(["kind": "device", "subject": deviceId])
        let grant: AceGrant = try await call("grants", method: "POST", token: token, body: body)
        guard !grant.token.isEmpty, grant.token.utf8.count <= 2048 else { throw .refused }
        return grant
    }
    /// Machines signed in to the account, most recently seen first.
    func machines(token: String) async throws(AccountGrantError) -> [AceMachine] {
        struct List: Decodable { let machines: [AceMachine] }
        let list: List = try await call("machines", method: "GET", token: token)
        return list.machines.filter { NoiseFingerprint.isHostId($0.hostId) }
    }
    /// Removes a machine from the account's list. It returns when it signs in again.
    func forget(token: String, hostId: String) async throws(AccountGrantError) {
        guard NoiseFingerprint.isHostId(hostId) else { throw .refused }
        let _: Ignored = try await call("machines/\(hostId)", method: "DELETE", token: token)
    }

    private struct Ignored: Decodable {}
    private func call<T: Decodable>(_ path: String, method: String, token: String, body: Data? = nil) async throws(AccountGrantError) -> T {
        var request = URLRequest(url: origin.appending(path: "v1/\(path)"))
        request.httpMethod = method
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let data: Data, response: URLResponse
        do { (data, response) = try await http.data(for: request) } catch { throw .unavailable }
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw .unavailable }
        try Self.check(status: status)
        guard data.count <= 64 * 1024 else { throw .refused }
        if T.self == Ignored.self, let ignored = Ignored() as? T { return ignored }
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw .refused }
    }
    /// What a backend status means for the phone. Pure.
    static func check(status: Int) throws(AccountGrantError) {
        if (200..<300).contains(status) { return }
        if status == 401 { throw .signedOut }
        if status == 429 || status >= 500 { throw .unavailable }
        throw .refused
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
