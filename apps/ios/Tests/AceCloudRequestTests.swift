import CryptoKit
import Foundation
import Network
import os
import Testing
@testable import Ace

private let testHostId = "A4IOPXUIEEM6GMLBBSWHEDA3CUUI64AG6CB4CALXPPRXWGPSVCRQ"
private let testToken43 = String(repeating: "t", count: 43)
private let testLoginId = String(repeating: "l", count: 43)
private let testLoginSecret = String(repeating: "s", count: 43)

/// Minimal loopback HTTP/WebSocket stub capturing each request's method, path and headers.
private final class CloudStubServer: @unchecked Sendable {
    struct Recorded: Sendable, Equatable {
        let method: String
        let path: String
        let headers: [String: String]
        var aceClient: String? { headers[AceCloudRequest.headerName] }
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "ace.tests.cloud-stub")
    private let lock = NSLock()
    private var connections: [NWConnection] = []
    private var entries: [Recorded] = []
    private var port: UInt16 = 0
    /// When true, `GET /v1/account/login/<id>` returns `pending` so cancellation can be tested.
    var keepLoginPending = false
    /// The status `DELETE /v1/account` answers, with `{"error":"person_session_required"}` on 403.
    var deleteAccountStatus = 200

    init() throws {
        listener = try NWListener(using: .tcp, on: .any)
    }

    func start() async throws -> URL {
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        let bound: UInt16 = try await withCheckedThrowingContinuation { continuation in
            let done = OSAllocatedUnfairLock(initialState: false)
            listener.stateUpdateHandler = { [listener] state in
                let value: UInt16? = if case .ready = state { listener.port?.rawValue } else { nil }
                let failed = if case .failed = state { true } else { false }
                guard value != nil || failed else { return }
                guard done.withLock({ seen in defer { seen = true }; return !seen }) else { return }
                if let value { continuation.resume(returning: value) }
                else { continuation.resume(throwing: HostError.transport) }
            }
            listener.start(queue: queue)
        }
        lock.withLock { port = bound }
        return URL(string: "http://127.0.0.1:\(bound)")!
    }

    func stop() {
        listener.cancel()
        for connection in lock.withLock({ connections }) { connection.cancel() }
    }

    var recorded: [Recorded] { lock.withLock { entries } }

    func first(method: String, pathPrefix: String) -> Recorded? {
        recorded.first { $0.method == method && $0.path.hasPrefix(pathPrefix) }
    }

    private func accept(_ connection: NWConnection) {
        lock.withLock { connections.append(connection) }
        connection.start(queue: queue)
        read(connection, buffer: Data())
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self, error == nil else { return }
            var buffer = buffer + (data ?? Data())
            while let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
                let lines = head.components(separatedBy: "\r\n")
                var headers: [String: String] = [:]
                for line in lines.dropFirst() {
                    guard let colon = line.firstIndex(of: ":") else { continue }
                    let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
                    let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                    headers[name] = value
                }
                let length = Int(headers["content-length"] ?? "0") ?? 0
                guard buffer.count >= end.upperBound - buffer.startIndex + length else { break }
                buffer = Data(buffer[(end.upperBound + length)...])
                let parts = (lines.first ?? "").split(separator: " ")
                let method = parts.first.map(String.init) ?? ""
                let path = parts.dropFirst().first.map(String.init) ?? ""
                lock.withLock { entries.append(Recorded(method: method, path: path, headers: headers)) }
                if let key = headers["sec-websocket-key"] {
                    let offered = headers["sec-websocket-protocol"] ?? ""
                    let echoed = offered.split(separator: ",").first
                        .map { "Sec-WebSocket-Protocol: \($0.trimmingCharacters(in: .whitespaces))\r\n" } ?? ""
                    let digest = Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
                    let accept = Data(digest).base64EncodedString()
                    let reply = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\(echoed)\r\n"
                    connection.send(content: Data(reply.utf8), completion: .contentProcessed { _ in })
                    return
                }
                let (contentType, body) = response(method: method, path: path)
                let status = method == "DELETE" && path == "/v1/account" ? lock.withLock { deleteAccountStatus } : 200
                let reply = "HTTP/1.1 \(status) Status\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
                connection.send(content: Data(reply.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
                return
            }
            if complete { return }
            self.read(connection, buffer: buffer)
        }
    }

    private func response(method: String, path: String) -> (String, Data) {
        let bound = lock.withLock { port }
        let future: Double = 9_999_999_999_000
        if method == "POST", path == "/v1/grants" {
            return ("application/json", Data(#"{"token":"device-grant-1","expiresAt":\#(Int64(future))}"#.utf8))
        }
        if method == "GET", path == "/v1/machines" {
            return ("application/json", Data(#"{"machines":[{"hostId":"\#(testHostId)","name":"studio","platform":"darwin","lastSeenAt":1}]}"#.utf8))
        }
        if method == "DELETE", path.hasPrefix("/v1/machines/") {
            return ("application/json", Data("{}".utf8))
        }
        if method == "POST", path == "/v1/account/login" {
            let loginUrl = "http://127.0.0.1:\(bound)/v1/account/login?id=\(testLoginId)"
            return ("application/json", Data(#"{"id":"\#(testLoginId)","secret":"\#(testLoginSecret)","loginUrl":"\#(loginUrl)","expiresAt":\#(Int64(future))}"#.utf8))
        }
        if method == "GET", path == "/v1/account/login/\(testLoginId)" {
            if keepLoginPending { return ("application/json", Data(#"{"status":"pending"}"#.utf8)) }
            let json = #"{"status":"complete","session":{"account":{"id":"acct_1","email":"ada@example.com","name":"Ada","picture":true},"token":"\#(testToken43)","expiresAt":\#(Int64(future))}}"#
            return ("application/json", Data(json.utf8))
        }
        if method == "DELETE", path == "/v1/account/login/\(testLoginId)" {
            return ("application/json", Data(#"{"ok":true}"#.utf8))
        }
        if method == "GET", path == "/v1/account/session" {
            let json = #"{"account":{"id":"acct_1","email":"ada@example.com","name":"Ada","picture":true},"expiresAt":\#(Int64(future))}"#
            return ("application/json", Data(json.utf8))
        }
        if method == "DELETE", path == "/v1/account/session" {
            return ("application/json", Data(#"{"ok":true}"#.utf8))
        }
        if method == "DELETE", path == "/v1/account" {
            let refused = lock.withLock { deleteAccountStatus } == 403
            return ("application/json", Data((refused ? #"{"error":"person_session_required"}"# : #"{"deleted":true}"#).utf8))
        }
        if method == "GET", path == "/v1/account/picture" {
            return ("image/png", Data([0x89, 0x50, 0x4E, 0x47]))
        }
        return ("application/json", Data("{}".utf8))
    }
}

@Suite struct AceCloudRequestTests {
    @Test func debugBuildsNameDevelopmentAndReleaseBuildsUseValidBundleVersions() {
        #expect(AceCloudRequest.clientValue(bundle: .main, isDebug: true) == "ios/development")
        #if DEBUG
        #expect(AceCloudRequest.defaultClient == "ios/development")
        #else
        #expect(AceCloudRequest.defaultClient == AceCloudRequest.clientValue(bundle: .main, isDebug: false))
        #endif
        // Release build reads CFBundleShortVersionString (project.yml MARKETING_VERSION = 0.1.0).
        if let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
           AceCloudRequest.isValidVersion(short) {
            #expect(AceCloudRequest.clientValue(bundle: .main, isDebug: false) == "ios/\(short)")
        }
    }

    @Test func versionValidationMatchesReleaseVersionContract() {
        let valid = [
            "development",
            "0.1.0",
            "1.3.0",
            "0.0.24-beta.1",
            "12.34.56-rc.0.1",
            "0.1.0-" + String(repeating: "a", count: 74),
        ]
        for version in valid {
            #expect(AceCloudRequest.clientValue(version: version) == "ios/\(version)")
        }

        let invalid: [String?] = [
            nil,
            "",
            "0.1",
            "0.1.0.0",
            "0.1.0-",
            "0.1.0-BETA.1",
            "0.1.0-beta-1",
            "0.1.0+build.1",
            "0.1.0\n",
            "development\n",
            " 0.1.0",
            "v0.1.0",
            "١.٢.٣",
            "0.1.0-" + String(repeating: "a", count: 75),
        ]
        for version in invalid {
            #expect(AceCloudRequest.clientValue(version: version) == nil)
        }
    }

    @Test func onlyAcesOwnHostsReceiveTheHeaderNeverSelfHostedRelays() throws {
        let hosted = [
            "https://cloud.acehq.dev/v1/account/session",
            "wss://cloud.acehq.dev/client?hostId=\(testHostId)",
            "https://relay.acehq.dev/v1/grants",
            "wss://relay.acehq.dev/client?hostId=\(testHostId)",
            "https://staging.cloud.acehq.dev/v1/machines",
            "wss://staging.cloud.acehq.dev/client?hostId=\(testHostId)",
            "https://CLOUD.ACEHQ.DEV/v1/account/picture",
        ]
        for address in hosted {
            let url = try #require(URL(string: address))
            let request = AceCloudRequest.make(url: url, client: "ios/0.1.0", allowLoopback: false)
            #expect(request.value(forHTTPHeaderField: "ace-client") == "ios/0.1.0", "expected header on \(address)")
        }

        let foreign = [
            "wss://relay.example.com/client?hostId=\(testHostId)",
            "https://accounts.example.com/v1/account/session",
            "wss://studio.tail1234.ts.net/client?hostId=\(testHostId)",
            "https://cloud.acehq.dev.evil.com/v1/grants",
            "https://notacehq.dev/v1/grants",
            "https://.acehq.dev/v1/grants",
            "https://a..acehq.dev/v1/grants",
            "http://cloud.acehq.dev/v1/grants",
            "ws://cloud.acehq.dev/client?hostId=\(testHostId)",
            "https://user:pass@cloud.acehq.dev/v1/grants",
            "wss://192.168.1.20:7443/ws",
            "http://127.0.0.1:8787/v1/grants",
            "ws://127.0.0.1:8787/client?hostId=\(testHostId)",
        ]
        for address in foreign {
            let url = try #require(URL(string: address))
            let request = AceCloudRequest.make(url: url, client: "ios/0.1.0", allowLoopback: false)
            #expect(request.value(forHTTPHeaderField: "ace-client") == nil, "unexpected header on \(address)")
        }

        // Loopback gets no header by default even in Debug builds; a fixture must opt in explicitly.
        let localHTTP = try #require(URL(string: "http://127.0.0.1:8787/v1/grants"))
        let localWS = try #require(URL(string: "ws://127.0.0.1:8787/client?hostId=\(testHostId)"))
        #expect(!AceCloudRequest.isAceHost(localHTTP))
        #expect(!AceCloudRequest.isAceHost(localWS))
        #expect(AceCloudRequest.make(url: localHTTP, client: "ios/development")
            .value(forHTTPHeaderField: "ace-client") == nil)
        #expect(AceCloudRequest.webSocket(url: localWS, protocols: ["ace.v2"], client: "ios/development")
            .value(forHTTPHeaderField: "ace-client") == nil)
        #expect(AceCloudRequest.make(url: localHTTP, client: "ios/development", allowLoopback: true)
            .value(forHTTPHeaderField: "ace-client") == "ios/development")
        #expect(AceCloudRequest.webSocket(url: localWS, protocols: ["ace.v2"], client: "ios/development", allowLoopback: true)
            .value(forHTTPHeaderField: "ace-client") == "ios/development")

        // A garbled client value is never sent even to ace's own host.
        let cloud = try #require(URL(string: "https://cloud.acehq.dev/v1/grants"))
        #expect(AceCloudRequest.make(url: cloud, client: "desktop/0.1.0", allowLoopback: false)
            .value(forHTTPHeaderField: "ace-client") == nil)
        #expect(AceCloudRequest.make(url: cloud, client: "ios/bad version", allowLoopback: false)
            .value(forHTTPHeaderField: "ace-client") == nil)
    }

    @Test func webSocketRequestCarriesSubprotocolsAlwaysAndAceClientOnlyForAceHosts() throws {
        let protocols = ["ace.grant.tok", "ace.v2", "ace.early.1"]
        let hosted = try #require(URL(string: "wss://cloud.acehq.dev/client?hostId=\(testHostId)"))
        let hostedRequest = AceCloudRequest.webSocket(url: hosted, protocols: protocols, client: "ios/1.2.3")
        #expect(hostedRequest.value(forHTTPHeaderField: "Sec-WebSocket-Protocol") == "ace.grant.tok, ace.v2, ace.early.1")
        #expect(hostedRequest.value(forHTTPHeaderField: "ace-client") == "ios/1.2.3")

        let selfHosted = try #require(URL(string: "wss://relay.example.com/client?hostId=\(testHostId)"))
        let selfHostedRequest = AceCloudRequest.webSocket(url: selfHosted, protocols: protocols, client: "ios/1.2.3")
        #expect(selfHostedRequest.value(forHTTPHeaderField: "Sec-WebSocket-Protocol") == "ace.grant.tok, ace.v2, ace.early.1")
        #expect(selfHostedRequest.value(forHTTPHeaderField: "ace-client") == nil)

        let localRelay = try #require(URL(string: "ws://127.0.0.1:8787/client?hostId=\(testHostId)"))
        let localRequest = AceCloudRequest.webSocket(url: localRelay, protocols: protocols, client: "ios/development")
        #expect(localRequest.value(forHTTPHeaderField: "Sec-WebSocket-Protocol") == "ace.grant.tok, ace.v2, ace.early.1")
        #expect(localRequest.value(forHTTPHeaderField: "ace-client") == nil)
    }
}

@Suite(.serialized) struct AceCloudClientHeaderDeliveryTests {
    private func until(_ done: () -> Bool) async throws {
        for _ in 0..<250 where !done() { try await Task.sleep(for: .milliseconds(20)) }
        #expect(done())
    }

    @MainActor
    @Test func debugLoopbackRequestsSendNoAceClientUnlessOptedIn() async throws {
        let server = try CloudStubServer()
        let origin = try await server.start()
        defer { server.stop() }
        let relayURL = try #require(AceAccountAPI(origin: origin).relayURL)
        let grants = AccountGrants { () async throws(AccountGrantError) -> AceGrant in
            AceGrant(token: "grant-1", expiresAt: Date().timeIntervalSince1970 * 1000 + 300_000)
        }
        let route = RelayRoute(relayURL: relayURL, hostId: testHostId, grants: grants)

        // Default allowLoopback is false even in Debug builds, so a local self-hosted relay or
        // backend receives no ace-client header.
        let api = AceAccountAPI(origin: origin, aceClient: "ios/development")
        _ = try await api.grant(token: testToken43, deviceId: "ios-1")

        let secrets = MemorySecrets()
        try secrets.set(origin.absoluteString, testToken43)
        let model = AceAccountModel(secrets: secrets, origin: origin, aceClient: "ios/development")
        await model.restore()

        let relay = RelaySocket(route: route, aceClient: "ios/development") { _, _ in }
        relay.open()
        defer { relay.close() }
        try await until { server.first(method: "GET", pathPrefix: "/client?hostId=\(testHostId)") != nil }

        #expect(server.first(method: "POST", pathPrefix: "/v1/grants")?.aceClient == nil)
        #expect(server.first(method: "GET", pathPrefix: "/v1/account/session")?.aceClient == nil)
        #expect(server.first(method: "GET", pathPrefix: "/v1/account/picture")?.aceClient == nil)
        let upgrade = try #require(server.first(method: "GET", pathPrefix: "/client?hostId=\(testHostId)"))
        #expect(upgrade.aceClient == nil)
        #expect(upgrade.headers["sec-websocket-protocol"]?.hasPrefix("ace.grant.grant-1") == true)
    }

    @Test func accountAPISendsAceClientOnGrantsMachinesAndForgetAndWorksWithoutIt() async throws {
        let server = try CloudStubServer()
        let origin = try await server.start()
        defer { server.stop() }
        let expected = try #require(AceCloudRequest.defaultClient)

        let api = AceAccountAPI(origin: origin, allowLoopback: true)
        _ = try await api.grant(token: testToken43, deviceId: "ios-1")
        let listed = try await api.machines(token: testToken43)
        #expect(listed.map(\.hostId) == [testHostId])
        try await api.forget(token: testToken43, hostId: testHostId)

        #expect(server.first(method: "POST", pathPrefix: "/v1/grants")?.aceClient == expected)
        #expect(server.first(method: "GET", pathPrefix: "/v1/machines")?.aceClient == expected)
        #expect(server.first(method: "DELETE", pathPrefix: "/v1/machines/\(testHostId)")?.aceClient == expected)

        let unnamed = AceAccountAPI(origin: origin, aceClient: nil, allowLoopback: true)
        _ = try await unnamed.grant(token: testToken43, deviceId: "ios-1")
        let last = try #require(server.recorded.last)
        #expect(last.method == "POST")
        #expect(last.path == "/v1/grants")
        #expect(last.aceClient == nil)
    }

    @MainActor
    @Test func accountModelSendsAceClientOnSessionPictureLogoutLoginPollAndCancel() async throws {
        let server = try CloudStubServer()
        let origin = try await server.start()
        defer { server.stop() }

        // Restore (session + loadPicture) and signOut (DELETE session).
        let secrets = MemorySecrets()
        try secrets.set(origin.absoluteString, testToken43)
        let model = AceAccountModel(secrets: secrets, origin: origin, aceClient: "ios/1.2.3", allowLoopback: true, pollInterval: .milliseconds(20))
        await model.restore()
        #expect(model.account?.email == "ada@example.com")
        #expect(model.picture == Data([0x89, 0x50, 0x4E, 0x47]))
        await model.signOut()
        #expect(model.account == nil)

        #expect(server.first(method: "GET", pathPrefix: "/v1/account/session")?.aceClient == "ios/1.2.3")
        #expect(server.first(method: "GET", pathPrefix: "/v1/account/picture")?.aceClient == "ios/1.2.3")
        #expect(server.first(method: "DELETE", pathPrefix: "/v1/account/session")?.aceClient == "ios/1.2.3")

        // Sign in (POST login + GET login/<id> poll + GET picture).
        model.signIn()
        try await until { model.account != nil && !model.busy }
        #expect(server.first(method: "POST", pathPrefix: "/v1/account/login")?.aceClient == "ios/1.2.3")
        #expect(server.first(method: "GET", pathPrefix: "/v1/account/login/\(testLoginId)")?.aceClient == "ios/1.2.3")
        await model.signOut()

        // Cancelled sign-in sends DELETE login/<id> with ace-client.
        server.keepLoginPending = true
        model.signIn()
        try await until { model.login != nil }
        model.cancel()
        try await until { server.first(method: "DELETE", pathPrefix: "/v1/account/login/\(testLoginId)") != nil }
        #expect(server.first(method: "DELETE", pathPrefix: "/v1/account/login/\(testLoginId)")?.aceClient == "ios/1.2.3")

        // Without ace-client, the same account calls still succeed.
        try secrets.set(origin.absoluteString, testToken43)
        let unnamed = AceAccountModel(secrets: secrets, origin: origin, aceClient: nil, allowLoopback: true)
        await unnamed.restore()
        #expect(unnamed.account?.email == "ada@example.com")
        let unnamedSession = try #require(server.recorded.last { $0.method == "GET" && $0.path == "/v1/account/session" })
        #expect(unnamedSession.aceClient == nil)
    }

    @MainActor
    @Test func deletingFromASessionTheBackendWontLetDeleteSaysToSignInAgainAndKeepsTheAccount() async throws {
        let server = try CloudStubServer()
        let origin = try await server.start()
        defer { server.stop() }
        server.deleteAccountStatus = 403
        let secrets = MemorySecrets()
        try secrets.set(origin.absoluteString, testToken43)
        let model = AceAccountModel(secrets: secrets, origin: origin, allowLoopback: true)
        await model.restore()
        #expect(await model.deleteAccount() == false)
        #expect(model.account?.email == "ada@example.com")
        #expect(model.error == "Sign out and sign in again on this phone, then delete your account.")
        server.deleteAccountStatus = 200
        #expect(await model.deleteAccount())
        #expect(model.account == nil)
    }

    @Test func relaySocketSendsAceClientOnDaemonAndMediaUpgradesAndWorksWithoutIt() async throws {
        let server = try CloudStubServer()
        let origin = try await server.start()
        defer { server.stop() }
        let expected = try #require(AceCloudRequest.defaultClient)
        let relayURL = try #require(AceAccountAPI(origin: origin).relayURL)
        let grants = AccountGrants { () async throws(AccountGrantError) -> AceGrant in
            AceGrant(token: "grant-1", expiresAt: Date().timeIntervalSince1970 * 1000 + 300_000)
        }
        let route = RelayRoute(relayURL: relayURL, hostId: testHostId, grants: grants)

        let daemon = RelaySocket(route: route, allowLoopback: true) { _, _ in }
        daemon.open()
        defer { daemon.close() }
        try await until { server.recorded.count == 1 }
        let first = try #require(server.recorded.first)
        #expect(first.path == "/client?hostId=\(testHostId)")
        #expect(first.aceClient == expected)
        #expect(first.headers["sec-websocket-protocol"]?.hasPrefix("ace.grant.grant-1") == true)

        let media = RelaySocket(route: route, purpose: "media", aceClient: "ios/0.2.0-beta.1", allowLoopback: true) { _, _ in }
        media.open()
        defer { media.close() }
        try await until { server.recorded.count == 2 }
        let second = server.recorded[1]
        #expect(second.path == "/client?hostId=\(testHostId)&purpose=media")
        #expect(second.aceClient == "ios/0.2.0-beta.1")
        #expect(second.headers["sec-websocket-protocol"]?.hasPrefix("ace.grant.grant-1") == true)

        let unnamed = RelaySocket(route: route, aceClient: nil, allowLoopback: true) { _, _ in }
        unnamed.open()
        defer { unnamed.close() }
        try await until { server.recorded.count == 3 }
        #expect(server.recorded[2].aceClient == nil)
    }
}
