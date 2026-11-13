import Foundation
import Observation

struct AceAccountIdentity: Codable {
    let id: String
    let email: String
    let name: String
    /// The account has a profile picture, which the backend relays (`GET /v1/account/picture`).
    var picture: Bool? = nil
}
private struct AccountSession: Decodable {
    let account: AceAccountIdentity
    let expiresAt: Double
}
private struct AccountGrant: Decodable {
    let account: AceAccountIdentity
    let token: String
    let expiresAt: Double
}
struct AceAccountLogin: Decodable {
    let id: String
    let secret: String
    let loginUrl: URL
    let expiresAt: Double
}
private struct AccountPoll: Decodable {
    let status: String
    let session: AccountGrant?
}
private enum AccountFailure: Error { case request, expired, invalid }

private final class AccountRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// The relay owns WorkOS credentials. The phone stores only its revocable ace session.
@MainActor @Observable final class AceAccountModel {
    private(set) var account: AceAccountIdentity?
    /// The account's profile picture as the backend relays it, so no third party sees which
    /// device shows it; nil without one, while loading, or when it couldn't be read (the avatar
    /// shows initials then).
    private(set) var picture: Data?
    private(set) var login: AceAccountLogin?
    private(set) var busy = false
    private(set) var error: String?
    private let origin: URL?
    private let secrets: any SecretStore
    private let now: () -> Double
    private let http = URLSession(configuration: .ephemeral, delegate: AccountRedirects(), delegateQueue: nil)
    private var token: String?
    @ObservationIgnored private var work: Task<Void, Never>?
    var configured: Bool { origin != nil }
    private var key: String { origin?.absoluteString ?? "" }

    init(settings: Bundle = .main, secrets: any SecretStore = KeychainSecrets(service: "app.ace.ios.account"),
         now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
        self.secrets = secrets
        self.now = now
        let value = settings.object(forInfoDictionaryKey: "AceAccountURL") as? String ?? ""
        let url = URL(string: value)
        let loopback = ["localhost", "127.0.0.1", "[::1]"].contains(url?.host ?? "")
        if let url, url.host != nil, url.user == nil, url.password == nil,
           url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
           url.scheme == "https" || (url.scheme == "http" && loopback) {
            origin = url
        } else { origin = nil }
    }

    func restore() async {
        guard configured, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            guard let saved = try AceHostedOrigins.savedToken(secrets, key: key) else { return }
            let session: AccountSession = try await call("session", token: saved)
            guard session.expiresAt > now() else { throw AccountFailure.expired }
            token = saved; account = session.account
            await loadPicture()
        } catch AccountFailure.expired {
            try? secrets.delete(key); token = nil; account = nil; picture = nil
        } catch { self.error = "Couldn't verify your account. Try again." }
    }

    deinit { http.invalidateAndCancel() }

    func signIn() {
        guard configured, !busy else { return }
        busy = true; error = nil
        work = Task { [weak self] in
            guard let self else { return }
            defer { busy = false; login = nil }
            do {
                // The browser comes back to `ace://account/signed-in`, which closes the sheet.
                let flow: AceAccountLogin = try await call("login", method: "POST", body: ["returnTo": AceSignInReturn.address])
                guard let origin, flow.loginUrl.scheme == origin.scheme,
                      flow.loginUrl.host == origin.host, flow.loginUrl.port == origin.port,
                      flow.loginUrl.path == "/v1/account/login",
                      URLComponents(url: flow.loginUrl, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "id" })?.value == flow.id,
                      validToken(flow.id), validToken(flow.secret) else { throw AccountFailure.invalid }
                login = flow
                while !Task.isCancelled {
                    try await Task.sleep(for: .seconds(2))
                    guard flow.expiresAt > now() else { throw AccountFailure.expired }
                    let result: AccountPoll
                    do { result = try await call("login/\(flow.id)", token: flow.secret) }
                    catch AccountFailure.expired { throw AccountFailure.expired }
                    catch AccountFailure.invalid { throw AccountFailure.invalid }
                    catch {
                        try Task.checkCancellation()
                        self.error = "Connection interrupted. Retrying sign-in…"
                        continue
                    }
                    if result.status == "pending" { continue }
                    guard result.status == "complete", let grant = result.session, validToken(grant.token) else { throw AccountFailure.invalid }
                    try Task.checkCancellation()
                    try secrets.set(key, grant.token)
                    token = grant.token; account = grant.account; login = nil; self.error = nil
                    await loadPicture()
                    return
                }
            } catch {
                if !Task.isCancelled { self.error = "Couldn't sign in. Try again." }
            }
            if let login { await cancelRemote(login) }
        }
    }

    func cancel() {
        work?.cancel()
    }

    /// The sign-in sheet closed on `url`, the browser's return address. The session still comes
    /// from the claim; a sign-in that didn't finish says so and stops waiting.
    func returned(_ url: URL) {
        guard let status = AceSignInReturn.status(url), let message = AceSignInReturn.message(status) else { return }
        work?.cancel()
        error = message
    }

    func signOut() async {
        guard let token, !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            try await remove("session", token: token)
            self.token = nil; account = nil; picture = nil
            do { try secrets.delete(key) }
            catch { self.error = "Signed out. Couldn't clear the saved account session." }
        } catch { self.error = "Couldn't sign out. Reconnect and try again." }
    }

    /// Reads the picture once per session. Only PNG, JPEG, WebP or GIF up to 1 MiB, as the web.
    private func loadPicture() async {
        guard let origin, let token, account?.picture == true else { picture = nil; return }
        var request = URLRequest(url: origin.appending(path: "v1/account/picture"))
        request.timeoutInterval = 15
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (bytes, response) = try? await http.bytes(for: request),
              let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
              (response.value(forHTTPHeaderField: "Content-Type") ?? "").range(of: "^image/(png|jpeg|webp|gif)$", options: .regularExpression) != nil
        else { return }
        var data = Data()
        do {
            for try await byte in bytes {
                guard data.count < Self.pictureLimit else { return }
                data.append(byte)
            }
        } catch { return }
        // Still the same session: a sign-out while it loaded keeps no picture.
        if self.token == token { picture = data }
    }
    private static let pictureLimit = 1024 * 1024

    private func validToken(_ value: String) -> Bool {
        value.utf8.count == 43 && value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    }
    private func cancelRemote(_ flow: AceAccountLogin) async {
        // A cancelled task cannot send cleanup. A separate task owns the bounded DELETE.
        let cleanup = Task { try? await self.remove("login/\(flow.id)", token: flow.secret) }
        await cleanup.value
    }
    private func remove(_ path: String, token: String) async throws {
        let _: [String: Bool] = try await call(path, method: "DELETE", token: token)
    }
    private func call<T: Decodable>(_ path: String, method: String = "GET", token: String? = nil, body: [String: String]? = nil) async throws -> T {
        guard let origin else { throw AccountFailure.request }
        var request = URLRequest(url: origin.appending(path: "v1/account/\(path)"))
        request.httpMethod = method; request.timeoutInterval = 15
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (bytes, response) = try await http.bytes(for: request)
        guard let response = response as? HTTPURLResponse else { throw AccountFailure.request }
        if response.statusCode == 401 || response.statusCode == 410 { throw AccountFailure.expired }
        if (400..<500).contains(response.statusCode) && response.statusCode != 429 { throw AccountFailure.invalid }
        guard (200..<300).contains(response.statusCode) else { throw AccountFailure.request }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 65_536 else { throw AccountFailure.invalid }
            data.append(byte)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
