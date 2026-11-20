import CryptoKit
import Foundation
import Network
import Testing
@testable import Ace

/// The relay socket's receive limit against a WebSocket peer that deflates its messages, as
/// the hosted relay's edge does (permessage-deflate): full-size Noise frames must still arrive.
@Suite(.timeLimit(.minutes(1))) struct RelayMessageLimitTests {
    @Test func aLongThreadsFullSizeFramesArriveThroughADeflatingRelayEdge() async throws {
        let (phoneKeys, daemonKeys) = try noisePair()
        var daemon = RelaySession(transport: daemonKeys)
        var phone = RelaySession(transport: phoneKeys)
        // A long thread's snapshot: over 1 MB of JSON, so every frame but the last is full size.
        let text = #"{"type":"snapshot","text":""# + String(repeating: "a", count: 1_100_000) + #""}"#
        let frames = try daemon.seal(text: text)
        #expect(frames.count > 16)
        #expect(frames.dropLast().allSatisfy { $0.count == noiseMaxMessage })

        let server = try DeflatingServer(messages: frames)
        let port = try await server.start()
        defer { server.stop() }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        RelaySocket.prepare(task)
        task.resume()
        var received: [RelayMessage] = []
        for _ in frames {
            guard case .data(let frame) = try await task.receive() else { Issue.record("text frame"); return }
            if let message = try phone.open(frame) { received.append(message) }
        }
        #expect(received == [.text(text)])
    }
}

/// One connection's WebSocket server: it accepts the upgrade with permessage-deflate and sends
/// each message compressed, as stored DEFLATE blocks (what a deflater makes of encrypted bytes).
private final class DeflatingServer: @unchecked Sendable {
    private let listener: NWListener
    private let messages: [Data]
    init(messages: [Data]) throws {
        self.messages = messages
        listener = try NWListener(using: .tcp, on: .any)
    }
    func start() async throws -> UInt16 {
        listener.newConnectionHandler = { [messages] connection in
            connection.start(queue: .global())
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, _, _ in
                let request = String(decoding: data ?? Data(), as: UTF8.self)
                let key = request.split(separator: "\r\n")
                    .first { $0.lowercased().hasPrefix("sec-websocket-key:") }
                    .map { $0.split(separator: ":", maxSplits: 1)[1].trimmingCharacters(in: .whitespaces) } ?? ""
                let digest = Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
                var out = Data(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    + "Sec-WebSocket-Accept: \(Data(digest).base64EncodedString())\r\n"
                    + "Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover\r\n\r\n").utf8)
                for message in messages { out.append(Self.frame(Self.stored(message))) }
                connection.send(content: out, completion: .idempotent)
            }
        }
        return try await withCheckedThrowingContinuation { continuation in
            let once = Once()
            listener.stateUpdateHandler = { [listener] state in
                switch state {
                case .ready: if let port = listener.port?.rawValue, once.take() { continuation.resume(returning: port) }
                case .failed(let error): if once.take() { continuation.resume(throwing: error) }
                default: break
                }
            }
            listener.start(queue: .global())
        }
    }
    func stop() { listener.cancel() }

    /// Raw DEFLATE stored blocks, ended as permessage-deflate's sync flush leaves them (RFC 7692).
    private static func stored(_ data: Data) -> Data {
        var out = Data()
        var offset = data.startIndex
        repeat {
            let end = min(offset + 65_535, data.endIndex)
            let count = UInt16(end - offset)
            out.append(0)
            out.append(contentsOf: [UInt8(count & 0xff), UInt8(count >> 8), UInt8(~count & 0xff), UInt8(~count >> 8)])
            out.append(data[offset..<end])
            offset = end
        } while offset < data.endIndex
        out.append(0)
        return out
    }
    /// A server frame: final, compressed (RSV1), binary, unmasked.
    private static func frame(_ payload: Data) -> Data {
        var out = Data([0xC2])
        if payload.count <= 0xffff {
            out.append(126)
            out.append(contentsOf: [UInt8(payload.count >> 8), UInt8(payload.count & 0xff)])
        } else {
            out.append(127)
            for shift in stride(from: 56, through: 0, by: -8) { out.append(UInt8((payload.count >> shift) & 0xff)) }
        }
        out.append(payload)
        return out
    }
}

private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var taken = false
    func take() -> Bool { lock.withLock { defer { taken = true }; return !taken } }
}
