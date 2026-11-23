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
    fileprivate let http: URLSession
    fileprivate let aceClient: String?
    fileprivate let allowLoopback: Bool

    init(origin: URL, aceClient: String? = AceCloudRequest.defaultClient, allowLoopback: Bool = false) {
        self.origin = origin
        self.aceClient = aceClient
        self.allowLoopback = allowLoopback
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
    /// The person's grant for one daemon and this phone's standing key (ADR 0190 §3): the
    /// `standing` of a device grant naming `host` and `key`. Nil when the backend gives none, as
    /// for a session from before standing was kept. Never offered to the relay or the script.
    func personGrant(token: String, deviceId: String, host: String, key: String) async throws(AccountGrantError) -> String? {
        struct Minted: Decodable { let standing: String? }
        let body = try? JSONEncoder().encode(["kind": "device", "subject": deviceId, "host": host, "key": key])
        let minted: Minted = try await call("grants", method: "POST", token: token, body: body)
        guard let standing = minted.standing, !standing.isEmpty, standing.utf8.count <= 2048 else { return nil }
        return standing
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

    fileprivate struct Ignored: Decodable {}
    private func call<T: Decodable>(_ path: String, method: String, token: String, body: Data? = nil) async throws(AccountGrantError) -> T {
        var request = AceCloudRequest.make(
            url: origin.appending(path: "v1/\(path)"),
            timeoutInterval: 15,
            cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
            client: aceClient,
            allowLoopback: allowLoopback
        )
        request.httpMethod = method
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

/// An organization the person is an active member of (`GET /v1/orgs`, ADR 0206 §1.4).
struct AceOrgSpace: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    /// The WorkOS role slug: `owner`, `admin`, `member`, `billing`, or one ace doesn't know.
    let role: String
    var plan: String? = nil
    var directoryManaged: Bool? = nil
}
/// A member as the organization's list names them, for a shared bot's approvers.
struct AceOrgMember: Decodable, Sendable, Equatable {
    let account: String
    var email: String? = nil
    var name: String? = nil
}
/// An org call the backend refused, with its `error` word (`last_owner`, `email_unverified`, …).
enum AceOrgError: Error, Equatable {
    case signedOut
    case refused(String)
    case unavailable
}

/// Organizations on the account backend (`packages/client/src/ace-org.ts`): the person's spaces,
/// a new one, an organization's hosts and members, and Leave. Every call is the person's session.
extension AceAccountAPI {
    func spaces(token: String) async throws(AceOrgError) -> [AceOrgSpace] {
        struct List: Decodable { let orgs: [AceOrgSpace] }
        let list: List = try await orgCall("orgs", method: "GET", token: token)
        return list.orgs.filter { Self.isOrgId($0.id) }
    }
    func createOrg(token: String, name: String) async throws(AceOrgError) -> AceOrgSpace {
        let body = try? JSONEncoder().encode(["name": name])
        return try await orgCall("orgs", method: "POST", token: token, body: body)
    }
    /// An organization's hosts, which the phone reaches like its own account machines.
    func hosts(token: String, org: String) async throws(AceOrgError) -> [AceMachine] {
        struct List: Decodable { let machines: [AceMachine] }
        guard Self.isOrgId(org) else { throw .refused("invalid") }
        let list: List = try await orgCall("orgs/\(org)/hosts", method: "GET", token: token)
        return list.machines
    }
    func members(token: String, org: String) async throws(AceOrgError) -> [AceOrgMember] {
        struct List: Decodable { let members: [AceOrgMember] }
        guard Self.isOrgId(org) else { throw .refused("invalid") }
        let list: List = try await orgCall("orgs/\(org)/members", method: "GET", token: token)
        return list.members
    }
    /// Leave: deletes the person's membership on the backend, nothing on the phone.
    func leave(token: String, org: String, account: String) async throws(AceOrgError) {
        guard Self.isOrgId(org), let segment = account.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else { throw .refused("invalid") }
        let _: Ignored = try await orgCall("orgs/\(org)/members/\(segment)", method: "DELETE", token: token)
    }
    /// `org_` and up to 64 letters or digits, as the backend names organizations.
    static func isOrgId(_ id: String) -> Bool {
        id.range(of: "^org_[A-Za-z0-9]{1,64}$", options: .regularExpression) != nil
    }

    private struct Refusal: Decodable { let error: String }
    private func orgCall<T: Decodable>(_ path: String, method: String, token: String, body: Data? = nil) async throws(AceOrgError) -> T {
        var request = AceCloudRequest.make(
            url: origin.appending(path: "v1/\(path)"),
            timeoutInterval: 15,
            cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
            client: aceClient,
            allowLoopback: allowLoopback
        )
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { request.httpBody = body; request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let data: Data, response: URLResponse
        do { (data, response) = try await http.data(for: request) } catch { throw .unavailable }
        guard let status = (response as? HTTPURLResponse)?.statusCode else { throw .unavailable }
        guard data.count <= 256 * 1024 else { throw .refused("too_large") }
        if status == 401 { throw .signedOut }
        if status == 429 || status >= 500 { throw .unavailable }
        guard (200..<300).contains(status) else {
            throw .refused((try? JSONDecoder().decode(Refusal.self, from: data))?.error ?? "refused")
        }
        if T.self == Ignored.self, let ignored = Ignored() as? T { return ignored }
        do { return try JSONDecoder().decode(T.self, from: data) } catch { throw .refused("invalid") }
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
