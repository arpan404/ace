import Foundation
import Testing
@testable import Ace

/// The pinned transport against a real loopback TLS server (`LocalTLSServer`).
@Suite(.serialized) struct PinnedSessionTests {
    private func post(_ session: PinnedSession, port: UInt16) async -> Result<PinnedHTTPResponse, PinnedHTTPError> {
        let origin = URL(string: "https://127.0.0.1:\(port)")!
        return await withCheckedContinuation { continuation in
            PinnedHTTP.send(on: session, origin: origin, request: PinnedHTTPRequest(method: "POST", path: "/v1/tickets", body: nil, token: nil)) {
                continuation.resume(returning: $0)
            }
        }
    }
    /// Opens a socket and waits for its first event: "open", or "close" with its code.
    private func open(_ target: ConnectionTarget, on session: PinnedSession?) async -> (PinnedSocket, String) {
        let answered = Answer()
        let socket = PinnedSocket(target: target, session: session) { kind, payload in
            guard kind == "open" || kind == "close" else { return }
            if case .text(let text) = payload { answered.give(kind == "open" ? "open" : "close \(text)") }
        }
        socket.open()
        return (socket, await answered.value())
    }

    @Test func ticketsOnOneMachineSessionReuseOneConnection() async throws {
        let server = try LocalTLSServer()
        let port = try await server.start()
        defer { server.stop() }
        let session = PinnedSession(host: "127.0.0.1", pin: server.pin)
        defer { session.close() }
        #expect(await post(session, port: port) == .success(PinnedHTTPResponse(status: 200, body: "{}")))
        #expect(await post(session, port: port) == .success(PinnedHTTPResponse(status: 200, body: "{}")))
        #expect(server.requests.count == 2)
        #expect(server.connections == 1, "the second ticket must not pay for a new TCP and TLS handshake")
    }
    @Test func requestsWithoutAMachineSessionEachOpenTheirOwnConnection() async throws {
        let server = try LocalTLSServer()
        let port = try await server.start()
        defer { server.stop() }
        let origin = URL(string: "https://127.0.0.1:\(port)")!
        for _ in 0..<2 {
            let result = await withCheckedContinuation { continuation in
                PinnedHTTP.send(origin: origin, pin: server.pin, request: PinnedHTTPRequest(method: "GET", path: "/v1/health", body: nil, token: nil)) {
                    continuation.resume(returning: $0)
                }
            }
            #expect(result == .success(PinnedHTTPResponse(status: 200, body: "{}")))
        }
        #expect(server.connections == 2)
    }
    @Test func theSocketAfterATicketOpensOnTheMachineSession() async throws {
        let server = try LocalTLSServer()
        let port = try await server.start()
        defer { server.stop() }
        let target = ConnectionTarget(endpoint: URL(string: "wss://127.0.0.1:\(port)/")!, hostId: "host", deviceId: "device",
                                      pin: server.pin, secretKey: "key")
        let session = PinnedSession(target: target)
        defer { session.close() }
        #expect(await post(session, port: port) == .success(PinnedHTTPResponse(status: 200, body: "{}")))
        let (socket, first) = await open(target, on: session)
        defer { socket.close() }
        #expect(first == "open")
        #expect(server.requests.map { $0.split(separator: " ").first.map(String.init) ?? "" } == ["POST", "GET"])
    }
    @Test func aSocketOnTheMachineSessionWithAChangedPinClosesAsATrustFailure() async throws {
        let server = try LocalTLSServer()
        let port = try await server.start()
        defer { server.stop() }
        let target = ConnectionTarget(endpoint: URL(string: "wss://127.0.0.1:\(port)/")!, hostId: "host", deviceId: "device",
                                      pin: String(repeating: "0", count: 64), secretKey: "key")
        let session = PinnedSession(target: target)
        defer { session.close() }
        let (_, first) = await open(target, on: session)
        #expect(first == "close 4003")
        #expect(server.requests.isEmpty)
    }
    @Test func aSocketWhoseUpgradeIsNeverAnsweredClosesAtItsConnectDeadline() async throws {
        let server = try LocalTLSServer()
        server.silent = ["/"]
        let port = try await server.start()
        defer { server.stop() }
        let target = ConnectionTarget(endpoint: URL(string: "wss://127.0.0.1:\(port)/")!, hostId: "host", deviceId: "device",
                                      pin: server.pin, secretKey: "key")
        let closed = Answer()
        let socket = PinnedSocket(target: target, connectTimeout: 0.3) { kind, payload in
            if case .text(let text) = payload, kind == "open" || kind == "close" { closed.give("\(kind) \(text)") }
        }
        let began = Date()
        socket.open()
        #expect(await closed.value() == "close 1006")
        #expect(Date().timeIntervalSince(began) < 5, "the deadline, not URLSession's 60 s, ends the attempt")
        #expect(server.requests.count == 1, "the upgrade reached the server, which never answered")
    }
    @Test func aChangedPinIsRefusedOnTheMachineSession() async throws {
        let server = try LocalTLSServer()
        let port = try await server.start()
        defer { server.stop() }
        let session = PinnedSession(host: "127.0.0.1", pin: String(repeating: "0", count: 64))
        defer { session.close() }
        #expect(await post(session, port: port) == .failure(.pin))
        #expect(await post(session, port: port) == .failure(.pin), "every new connection is checked against the pin")
        #expect(server.requests.isEmpty, "nothing is sent to a server that failed the pin")
    }
    @Test func aRequestForAnotherHostIsRefusedBeforeItIsSent() async throws {
        let session = PinnedSession(host: "127.0.0.1", pin: String(repeating: "a", count: 64))
        defer { session.close() }
        let result = await withCheckedContinuation { continuation in
            PinnedHTTP.send(on: session, origin: URL(string: "https://192.0.2.1:4243")!, request: PinnedHTTPRequest(method: "POST", path: "/v1/tickets", body: nil, token: nil)) {
                continuation.resume(returning: $0)
            }
        }
        #expect(result == .failure(.invalid))
    }
}

/// One answer, given once from any thread and awaited once.
final class Answer: @unchecked Sendable {
    private let lock = NSLock()
    private var given: String?
    private var waiting: CheckedContinuation<String, Never>?
    func give(_ value: String) {
        let resume: CheckedContinuation<String, Never>? = lock.withLock {
            guard given == nil else { return nil }
            given = value
            defer { waiting = nil }
            return waiting
        }
        resume?.resume(returning: value)
    }
    func value() async -> String {
        await withCheckedContinuation { continuation in
            let ready: String? = lock.withLock {
                if let given { return given }
                waiting = continuation
                return nil
            }
            if let ready { continuation.resume(returning: ready) }
        }
    }
}
