import CryptoKit
import Foundation
import Network
import os

/// A loopback WebSocket daemon for liveness tests: it welcomes every hello as host `host` and
/// answers each ping with a pong, until `silence()`, after which it sends nothing at all and
/// never closes, as a socket left on an interface that went away. Between `hold()` and
/// `release()` its pongs are written but stay in transit: they arrive, in order, only then.
final class SilentDaemon: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "ace.tests.silent-daemon")
    private let lock = NSLock()
    private var silent = false
    private var connections: [NWConnection] = []
    private var answered = 0
    private var received = 0
    private var holding = false
    private var held: [NWConnection] = []

    init() throws { listener = try NWListener(using: .tcp, on: .any) }

    func start() async throws -> UInt16 {
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, Error>) in
            let answered = OSAllocatedUnfairLock(initialState: false)
            listener.stateUpdateHandler = { [listener] state in
                let port: UInt16? = if case .ready = state { listener.port?.rawValue } else { nil }
                let failed = if case .failed = state { true } else { false }
                guard port != nil || failed else { return }
                let first = answered.withLock { done -> Bool in defer { done = true }; return !done }
                guard first else { return }
                if let port { continuation.resume(returning: port) } else { continuation.resume(throwing: URLError(.cannotConnectToHost)) }
            }
            listener.start(queue: queue)
        }
    }
    func stop() {
        listener.cancel()
        for connection in lock.withLock({ connections }) { connection.cancel() }
    }
    /// From now on nothing reaches any client, and nothing is closed.
    func silence() { lock.withLock { silent = true } }
    /// Pings answered so far.
    var pongs: Int { lock.withLock { answered } }
    /// Pings received so far, answered or not.
    var pings: Int { lock.withLock { received } }
    /// Pongs from now on stay in transit until `release()`.
    func hold() { lock.withLock { holding = true } }
    /// The pongs in transit arrive now, in order, even after `silence()`: they left before.
    func release() {
        let late = lock.withLock { () -> [NWConnection] in
            holding = false
            answered += held.count
            defer { held.removeAll() }
            return held
        }
        for connection in late { send(#"{"type":"pong"}"#, on: connection) }
    }

    private func accept(_ connection: NWConnection) {
        lock.withLock { connections.append(connection) }
        connection.start(queue: queue)
        upgrade(connection, buffer: Data())
    }
    private func upgrade(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self, error == nil else { return }
            let buffer = buffer + (data ?? Data())
            guard let end = buffer.range(of: Data("\r\n\r\n".utf8)) else {
                if !complete { self.upgrade(connection, buffer: buffer) }
                return
            }
            let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
            let key = head.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("sec-websocket-key:") }
                .map { String($0.dropFirst("sec-websocket-key:".count)).trimmingCharacters(in: .whitespaces) } ?? ""
            let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
            connection.send(content: Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n".utf8),
                            completion: .contentProcessed { _ in })
            self.frames(connection, buffer: Data(buffer[end.upperBound...]))
        }
    }
    /// Reads the client's masked frames and answers the text ones.
    private func frames(_ connection: NWConnection, buffer start: Data) {
        var buffer = start
        while let (opcode, payload, used) = Self.frame(Array(buffer)) {
            buffer = Data(buffer.dropFirst(used))
            guard opcode == 1 else { continue }
            let text = String(decoding: payload, as: UTF8.self)
            if text.contains(#""type":"ping""#) { lock.withLock { received += 1 } }
            guard !lock.withLock({ silent }) else { continue }
            if text.contains(#""type":"hello""#) {
                send(#"{"type":"welcome","hostId":"host","protocolVersion":1,"headSeq":0}"#, on: connection)
            } else if text.contains(#""type":"ping""#) {
                let answer = lock.withLock { () -> Bool in
                    if holding { held.append(connection); return false }
                    answered += 1
                    return true
                }
                if answer { send(#"{"type":"pong"}"#, on: connection) }
            }
        }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self, error == nil, !complete || data != nil else { return }
            self.frames(connection, buffer: buffer + (data ?? Data()))
        }
    }
    private func send(_ text: String, on connection: NWConnection) {
        let payload = Array(text.utf8)
        var frame: [UInt8] = [0x81]
        if payload.count < 126 { frame.append(UInt8(payload.count)) } else {
            frame += [126, UInt8(payload.count >> 8), UInt8(payload.count & 0xff)]
        }
        connection.send(content: Data(frame + payload), completion: .contentProcessed { _ in })
    }
    /// One complete client frame at the start of `bytes`: its opcode, unmasked payload and size.
    private static func frame(_ bytes: [UInt8]) -> (UInt8, [UInt8], Int)? {
        guard bytes.count >= 2 else { return nil }
        var length = Int(bytes[1] & 0x7f)
        var at = 2
        if length == 126 {
            guard bytes.count >= 4 else { return nil }
            length = Int(bytes[2]) << 8 | Int(bytes[3]); at = 4
        } else if length == 127 {
            guard bytes.count >= 10 else { return nil }
            length = (2..<10).reduce(0) { $0 << 8 | Int(bytes[$1]) }; at = 10
        }
        let masked = bytes[1] & 0x80 != 0
        let mask = masked ? Array(bytes[at..<min(at + 4, bytes.count)]) : []
        if masked { at += 4 }
        guard bytes.count >= at + length else { return nil }
        let payload = (0..<length).map { masked ? bytes[at + $0] ^ mask[$0 % 4] : bytes[at + $0] }
        return (bytes[0] & 0x0f, payload, at + length)
    }
}
