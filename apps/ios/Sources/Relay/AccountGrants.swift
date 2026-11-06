import Foundation

/// Device grants for one account machine's runtime. Every relay connection fetches a fresh one
/// (`fresh`); the hello on that connection presents the same grant (`current`) unless it is
/// about to lapse. Grants are never stored: they live five minutes and only in memory.
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
        let kept = lock.withLock { latest }
        if let kept, kept.expiresAt - now() > Self.margin { return kept.token }
        return try await fresh()
    }
}

/// Where the phone keeps its ace session token: the Keychain, per account origin.
struct AceAccountSessionStore: Sendable {
    let origin: URL
    var secrets: any SecretStore = KeychainSecrets(service: "app.ace.ios.account")
    private var key: String { origin.absoluteString }

    func token() -> String? { (try? secrets.get(key)).flatMap { $0 } }
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
    /// `/client?hostId=…` on the relay. WSS, or WS on loopback for development.
    var clientURL: URL? {
        guard var components = URLComponents(url: relayURL, resolvingAgainstBaseURL: false),
              relayURL.user == nil, relayURL.password == nil, relayURL.query == nil, relayURL.fragment == nil else { return nil }
        let loopback = ["localhost", "127.0.0.1", "::1"].contains(components.host ?? "")
        guard components.scheme == "wss" || (components.scheme == "ws" && loopback) else { return nil }
        components.path = "/client"
        components.queryItems = [URLQueryItem(name: "hostId", value: hostId)]
        return components.url
    }
}
