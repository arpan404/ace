import Foundation

/// Device grants for one account machine's runtime. A relay connection and the hello on it
/// present the kept grant while it has more than `margin` left (`current`), so a reconnect
/// costs no backend round trip before its socket opens; one the relay or daemon refused is
/// dropped (`discard`), and an open socket's refresh always fetches anew (`fresh`). Grants are
/// never stored: they live five minutes and only in memory.
final class AccountGrants: @unchecked Sendable {
    /// A grant this close to expiry is not offered again.
    static let margin: Double = 60_000
    private let fetch: @Sendable () async throws(AccountGrantError) -> AceGrant
    private let now: @Sendable () -> Double
    private let lock = NSLock()
    private var latest: AceGrant?

    init(now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 * 1000 },
         fetch: @escaping @Sendable () async throws(AccountGrantError) -> AceGrant) {
        self.fetch = fetch; self.now = now
    }
    /// The phone's ace session, read from the Keychain for every request: signing out stops the
    /// next connection without telling each runtime.
    convenience init(api: AceAccountAPI, session: AceAccountSessionStore, deviceId: String) {
        self.init { () async throws(AccountGrantError) -> AceGrant in
            guard let token = session.token() else { throw .signedOut }
            return try await api.grant(token: token, deviceId: deviceId)
        }
    }

    func fresh() async throws(AccountGrantError) -> String {
        let grant = try await fetch()
        lock.withLock { latest = grant }
        return grant.token
    }
    func current() async throws(AccountGrantError) -> String {
        if let kept = kept() { return kept }
        return try await fresh()
    }
    /// The kept grant, if it has more than `margin` left; never fetches.
    func kept() -> String? {
        let kept = lock.withLock { latest }
        guard let kept, kept.expiresAt - now() > Self.margin else { return nil }
        return kept.token
    }
    /// `token` was refused: the next connection fetches a new grant. A newer one is kept.
    func discard(_ token: String) {
        lock.withLock { if latest?.token == token { latest = nil } }
    }
}

/// Where the phone keeps its ace session token: the Keychain, per account origin.
/// ace's backend moved from these addresses to `current` (`ACE_FORMER_HOSTED_ACCOUNT_ORIGINS`);
/// it still answers there with the same sessions, so a session saved under one is still good.
enum AceHostedOrigins {
    static let current = "https://cloud.acehq.dev"
    static let former = ["https://relay.acehq.dev"]

    /// The session saved under `key` (an account origin). For ace's current address, one left
    /// under a former address is moved to it, so the person stays signed in after the move.
    static func savedToken(_ secrets: any SecretStore, key: String) throws -> String? {
        if let token = try secrets.get(key) { return token }
        guard key == current else { return nil }
        for address in former {
            guard let token = try secrets.get(address) else { continue }
            try secrets.set(key, token)
            try? secrets.delete(address)
            return token
        }
        return nil
    }
}

struct AceAccountSessionStore: Sendable {
    let origin: URL
    var secrets: any SecretStore = KeychainSecrets(service: "app.ace.ios.account")
    private var key: String { origin.absoluteString }

    func token() -> String? { (try? AceHostedOrigins.savedToken(secrets, key: key)).flatMap { $0 } }
    func save(_ token: String) throws { try secrets.set(key, token) }
    func clear() throws { try secrets.delete(key) }
    /// This phone's device id on the account: the grant's subject, and the name each machine
    /// remembers a passed machine code under. It is the install id (ADR 0115), the same for every
    /// account origin and across signing out and in; not a secret.
    func deviceId(install: InstallIdentity = .system) -> String { install.id() }
}

/// An account machine reached through ace's hosted relay.
struct RelayRoute: Sendable {
    static let grantPrefix = "ace.grant."
    let relayURL: URL
    let hostId: String
    let grants: AccountGrants

    var isValid: Bool { clientURL != nil && NoiseFingerprint.isHostId(hostId) }
    var clientURL: URL? { clientURL(purpose: nil) }
    /// `/client?hostId=…` on the relay, with `&purpose=media` for a media connection's stream.
    /// WSS, or WS on loopback for development.
    func clientURL(purpose: String?) -> URL? {
        guard var components = URLComponents(url: relayURL, resolvingAgainstBaseURL: false),
              relayURL.user == nil, relayURL.password == nil, relayURL.query == nil, relayURL.fragment == nil else { return nil }
        let loopback = ["localhost", "127.0.0.1", "::1"].contains(components.host ?? "")
        guard components.scheme == "wss" || (components.scheme == "ws" && loopback) else { return nil }
        components.path = "/client"
        components.queryItems = [URLQueryItem(name: "hostId", value: hostId)]
            + (purpose.map { [URLQueryItem(name: "purpose", value: $0)] } ?? [])
        return components.url
    }
}
