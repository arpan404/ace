import Darwin
import Foundation
import Network
import Testing
@testable import Ace

/// A runtime's side of the loopback, recording what the hub tells it.
private final class RecordingClient: LoopbackClient, @unchecked Sendable {
    private let lock = NSLock()
    private var events: [LoopbackEvent] = []
    func loopback(_ event: LoopbackEvent) { lock.withLock { events.append(event) } }
    var seen: [LoopbackEvent] { lock.withLock { events } }
    func wait(_ label: String, for match: @escaping (LoopbackEvent) -> Bool) async throws -> LoopbackEvent {
        for _ in 0..<400 {
            if let found = seen.first(where: match) { return found }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw LoopbackTestError.timedOut(label)
    }
    func bytes(of id: String) -> Data {
        seen.reduce(into: Data()) { all, event in if case .data(id, let bytes) = event { all.append(bytes) } }
    }
}
private enum LoopbackTestError: Error { case timedOut(String) }

/// A free loopback port, found by binding port 0 and letting it go.
private func freePort() -> Int {
    let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    defer { close(socket) }
    var address = sockaddr_in(sin_len: UInt8(MemoryLayout<sockaddr_in>.size), sin_family: sa_family_t(AF_INET),
                              sin_port: 0, sin_addr: in_addr(s_addr: inet_addr("127.0.0.1")), sin_zero: (0, 0, 0, 0, 0, 0, 0, 0))
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    withUnsafeMutablePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { _ = bind(socket, $0, length); _ = getsockname(socket, $0, &length) }
    }
    return Int(UInt16(bigEndian: address.sin_port))
}

/// A port another app holds: a plain socket listening on it until `close`.
private func holdPort(_ port: Int) -> Int32 {
    let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    var address = sockaddr_in(sin_len: UInt8(MemoryLayout<sockaddr_in>.size), sin_family: sa_family_t(AF_INET),
                              sin_port: UInt16(port).bigEndian, sin_addr: in_addr(s_addr: inet_addr("127.0.0.1")), sin_zero: (0, 0, 0, 0, 0, 0, 0, 0))
    withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { _ = bind(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    listen(socket, 4)
    return socket
}

private func listen(_ hub: LoopbackHub, _ ports: [Int], for client: any LoopbackClient) async -> LoopbackListening {
    await withCheckedContinuation { continuation in hub.listen(ports, for: client) { continuation.resume(returning: $0) } }
}

/// A page's connection: a plain TCP client on the phone's loopback.
private final class PageSocket: @unchecked Sendable {
    let connection: NWConnection
    private let lock = NSLock()
    private var received = Data()
    private var ended = false
    private var failed = false
    init(host: NWEndpoint.Host, port: Int) {
        connection = NWConnection(host: host, port: NWEndpoint.Port(rawValue: UInt16(port))!, using: .tcp)
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.lock.withLock { self?.failed = true } }
        }
        connection.start(queue: DispatchQueue(label: "test.page"))
        receive()
    }
    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self else { return }
            self.lock.withLock {
                if let data { self.received.append(data) }
                if complete { self.ended = true }
                if error != nil { self.failed = true }
            }
            if !complete, error == nil { self.receive() }
        }
    }
    func send(_ text: String, final: Bool = false) {
        connection.send(content: Data(text.utf8), contentContext: final ? .finalMessage : .defaultMessage, isComplete: final, completion: .idempotent)
    }
    var text: String { lock.withLock { String(decoding: received, as: UTF8.self) } }
    var endedOrFailed: (ended: Bool, failed: Bool) { lock.withLock { (ended, failed) } }
    func waitFor(_ label: String, _ condition: @escaping (PageSocket) -> Bool) async throws {
        for _ in 0..<400 {
            if condition(self) { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw LoopbackTestError.timedOut(label)
    }
}

@Suite(.serialized) struct LoopbackHubTests {
    @Test func aPageOnLocalhostReachesTheScriptAndHearsItsAnswer() async throws {
        let hub = LoopbackHub(queue: DispatchQueue(label: "test.loopback"))
        let client = RecordingClient()
        let port = freePort()
        let answer = await listen(hub, [port], for: client)
        #expect(answer == LoopbackListening(listening: [port], busy: []))

        let page = PageSocket(host: .ipv4(.loopback), port: port)
        let accepted = try await client.wait("accept") { if case .accept = $0 { true } else { false } }
        guard case .accept(let id, let acceptedPort) = accepted else { return }
        #expect(acceptedPort == port)

        page.send("GET / HTTP/1.1\r\n\r\n")
        // Nothing is read until the script asks: the tunnel's credit paces the page.
        try await Task.sleep(for: .milliseconds(50))
        #expect(client.bytes(of: id).isEmpty)
        hub.act(id, action: "read", bytes: nil)
        _ = try await client.wait("data") { if case .data = $0 { true } else { false } }
        #expect(String(decoding: client.bytes(of: id), as: UTF8.self) == "GET / HTTP/1.1\r\n\r\n")

        hub.act(id, action: "write", bytes: Data("HTTP/1.1 200 OK\r\n\r\nhi".utf8))
        _ = try await client.wait("written") { $0 == .written(id) }
        hub.act(id, action: "end", bytes: nil)
        try await page.waitFor("answer and end") { $0.text == "HTTP/1.1 200 OK\r\n\r\nhi" && $0.endedOrFailed.ended }
        _ = await listen(hub, [], for: client)
    }

    @Test func thePageHalfClosingReachesTheScriptAsEnd() async throws {
        let hub = LoopbackHub(queue: DispatchQueue(label: "test.loopback"))
        let client = RecordingClient()
        let port = freePort()
        _ = await listen(hub, [port], for: client)
        let page = PageSocket(host: .ipv4(.loopback), port: port)
        let accepted = try await client.wait("accept") { if case .accept = $0 { true } else { false } }
        guard case .accept(let id, _) = accepted else { return }
        page.send("bye", final: true)
        hub.act(id, action: "read", bytes: nil)
        _ = try await client.wait("data") { if case .data = $0 { true } else { false } }
        hub.act(id, action: "read", bytes: nil)
        _ = try await client.wait("end") { $0 == .end(id) }
        // The machine can still answer after the page's half-close.
        hub.act(id, action: "write", bytes: Data("late".utf8))
        _ = try await client.wait("written") { $0 == .written(id) }
        try await page.waitFor("late answer") { $0.text == "late" }
        _ = await listen(hub, [], for: client)
    }

    @Test func theIPv6LoopbackOnTheSamePortReachesTheScript() async throws {
        let hub = LoopbackHub(queue: DispatchQueue(label: "test.loopback"))
        let client = RecordingClient()
        let port = freePort()
        _ = await listen(hub, [port], for: client)
        _ = PageSocket(host: .ipv6(.loopback), port: port)
        _ = try await client.wait("accept on ::1") { if case .accept(_, port) = $0 { true } else { false } }
        _ = await listen(hub, [], for: client)
    }

    @Test func aResetFromTheScriptDropsThePage() async throws {
        let hub = LoopbackHub(queue: DispatchQueue(label: "test.loopback"))
        let client = RecordingClient()
        let port = freePort()
        _ = await listen(hub, [port], for: client)
        let page = PageSocket(host: .ipv4(.loopback), port: port)
        let accepted = try await client.wait("accept") { if case .accept = $0 { true } else { false } }
        guard case .accept(let id, _) = accepted else { return }
        hub.act(id, action: "reset", bytes: nil)
        try await page.waitFor("dropped") { $0.endedOrFailed.ended || $0.endedOrFailed.failed }
        _ = await listen(hub, [], for: client)
    }

    @Test func aPortAnotherAppHoldsIsReportedBusy() async throws {
        let hub = LoopbackHub(queue: DispatchQueue(label: "test.loopback"))
        let client = RecordingClient()
        let held = freePort(), free = freePort()
        let socket = holdPort(held)
        defer { close(socket) }
        let answer = await listen(hub, [held, free], for: client)
        #expect(answer.busy == [held])
        #expect(answer.listening == [free])
        _ = await listen(hub, [], for: client)
    }

    @Test func anotherRuntimeAskingTakesTheListenersAndThePortServesIt() async throws {
        let hub = LoopbackHub(queue: DispatchQueue(label: "test.loopback"))
        let first = RecordingClient(), second = RecordingClient()
        let port = freePort()
        _ = await listen(hub, [port], for: first)
        let answer = await listen(hub, [port], for: second)
        #expect(answer.listening == [port])
        _ = try await first.wait("released") { $0 == .released }
        _ = PageSocket(host: .ipv4(.loopback), port: port)
        _ = try await second.wait("accept") { if case .accept = $0 { true } else { false } }
        #expect(!first.seen.contains { if case .accept = $0 { true } else { false } })
        _ = await listen(hub, [], for: second)
    }

    @Test func listeningOnNothingFreesThePort() async throws {
        let hub = LoopbackHub(queue: DispatchQueue(label: "test.loopback"))
        let client = RecordingClient()
        let port = freePort()
        _ = await listen(hub, [port], for: client)
        _ = await listen(hub, [], for: client)
        // Free again: another listener can take it.
        let otherHub = LoopbackHub(queue: DispatchQueue(label: "test.other"))
        let other = await listen(otherHub, [port], for: client)
        #expect(other.listening == [port])
        _ = await listen(otherHub, [], for: client)
    }
}
