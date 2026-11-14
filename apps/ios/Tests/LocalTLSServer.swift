import CryptoKit
import Foundation
import Network
import os
import Security
@testable import Ace

/// A loopback HTTPS and WSS server with a throwaway self-signed identity, made for these tests
/// only (P-256, CN=ace-test, password "ace"; it authenticates nothing anywhere else). It counts
/// the TCP connections it accepts and the requests on them, answers every request `200 {}`
/// with keep-alive, and upgrades WebSocket requests, which then stay open.
final class LocalTLSServer: @unchecked Sendable {
    private static let identity = "MIIDegIBAzCCA0AGCSqGSIb3DQEHAaCCAzEEggMtMIIDKTCCAh8GCSqGSIb3DQEHBqCCAhAwggIMAgEAMIICBQYJKoZIhvcNAQcBMBwGCiqGSIb3DQEMAQMwDgQIWuySv7MVgKQCAggAgIIB2DHh6YjHdrQIMlGrLxFDpvnAGcKBT+YIgQduW8A2iYqvrc9dbGJzjte8wNB5NW/rWWwjd4HXJ9dlAYd9lBjHsXUu4iMf2wtZxyJ0tcqL2dQbjUK2XQm5QN1fKYlOtrq8hUW+dUYEU2laAZHtq+RmZtM+sp8jgnge2+x0i7qphoQ29SV8UJfk5Nxsyzv4th6sAADo88SZp91ddG2zNKi+ICRmUvbjgv4wyK8W0AkvUJdDiKJlcvj10I+/Zp1dK4Duwwdb+zBJ+efFK3bUIp+vm167avoStdVImsqXg0KczQF+qn7a6Zy271UClyDmGEoOHVzTwfc2xd6kcqoplrJ5ONH2mKrA5QcjLB1ZB6Uin/SRWJSqeiY2uzBcvCNyUFZcAo08ayIHK8zA7q87iA4LcdHFPwIHyQfk7e7hGPzNKDAuldgXBl2nEqp7PRYQmowy8wuIBaQx7g5rtwTcw9wV3mXNBAp1gd4Hcg6t3ANWPMtYiOyFylVR3fcMCj93EJpJZ1Po4ZejWHQFoB2HUm4I8X2bL/JZVU/cKOtKq91VzN0lDJGbHBHbFMGie5B7QK0w0Gj0povAI+hWNnM8Vm8cYOAG4KEN5Tfsb6p/sk52HDoymKag3+p02R8wggECBgkqhkiG9w0BBwGggfQEgfEwge4wgesGCyqGSIb3DQEMCgECoIG0MIGxMBwGCiqGSIb3DQEMAQMwDgQIfxjpCNd/G30CAggABIGQ/TstCBtapLuaWl1tE1qufBYKOBhjOzKIEMXWbX+JnbJxjCv9we5W9F4uDwyoTvdYe0ITjAXfOLbQzikduwVb+ER9s2hBFMrgK8k4T13/HZeYGgjEDmJGKURr0Ri/w1N8NFZwq2xh+ml8fskzp3KX4cUeWFirU5zZbJzIRfbspfDTvhoez/xeswrpCkLb/sbxMSUwIwYJKoZIhvcNAQkVMRYEFGYNyxZYiXvFoDKDEPxwV/AjrWi2MDEwITAJBgUrDgMCGgUABBQ4urRCmYQ6EPXsQiSYs0pEerC8GgQIaea1oH7VPPgCAggA"

    let pin: String
    private let listener: NWListener
    private let queue = DispatchQueue(label: "ace.tests.tls")
    private let lock = NSLock()
    private var accepted: [NWConnection] = []
    private var lines: [String] = []
    private var offered: [String] = []
    /// WebSocket upgrades answered with this status instead of 101, as a relay refusing a grant.
    var refuseUpgrades: Int?
    /// Requests that get no answer at all, by path: a machine that stopped responding.
    var silent: Set<String> = []

    /// `tls: false` serves plain HTTP and WS on loopback, as a development relay does.
    init(tls useTLS: Bool = true) throws {
        var items: CFArray?
        let options = [kSecImportExportPassphrase as String: "ace"] as CFDictionary
        guard SecPKCS12Import(Data(base64Encoded: Self.identity)! as CFData, options, &items) == errSecSuccess,
              let first = (items as? [[String: Any]])?.first,
              let value = first[kSecImportItemIdentity as String] else { throw HostError.transport }
        let identity = value as! SecIdentity // swiftlint:disable:this force_cast — CF type from the import.
        var certificate: SecCertificate?
        SecIdentityCopyCertificate(identity, &certificate)
        guard let certificate else { throw HostError.transport }
        pin = try CertificatePin.digest(certificate: SecCertificateCopyData(certificate) as Data)
        guard useTLS else { listener = try NWListener(using: .tcp, on: .any); return }
        let tls = NWProtocolTLS.Options()
        guard let local = sec_identity_create(identity) else { throw HostError.transport }
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, local)
        listener = try NWListener(using: NWParameters(tls: tls), on: .any)
    }

    /// Starts listening on loopback; the port it got.
    func start() async throws -> UInt16 {
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UInt16, Error>) in
            let answered = OSAllocatedUnfairLock(initialState: false)
            listener.stateUpdateHandler = { [listener] state in
                let port: UInt16? = if case .ready = state { listener.port?.rawValue } else { nil }
                let failed = if case .failed = state { true } else { false }
                guard port != nil || failed else { return }
                guard answered.withLock({ done in defer { done = true }; return !done }) else { return }
                if let port { continuation.resume(returning: port) } else { continuation.resume(throwing: HostError.transport) }
            }
            listener.start(queue: queue)
        }
    }
    func stop() {
        listener.cancel()
        for connection in lock.withLock({ accepted }) { connection.cancel() }
    }
    var connections: Int { lock.withLock { accepted.count } }
    /// Each request's first line, in arrival order.
    var requests: [String] { lock.withLock { lines } }
    /// Each WebSocket upgrade's offered subprotocols, in arrival order.
    var subprotocols: [String] { lock.withLock { offered } }

    private func accept(_ connection: NWConnection) {
        lock.withLock { accepted.append(connection) }
        connection.start(queue: queue)
        read(connection, buffer: Data())
    }
    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self, error == nil else { return }
            var buffer = buffer + (data ?? Data())
            while let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
                let headers = head.components(separatedBy: "\r\n")
                let field = { (name: String) in
                    headers.dropFirst().first { $0.lowercased().hasPrefix(name + ":") }
                        .map { String($0.dropFirst(name.count + 1)).trimmingCharacters(in: .whitespaces) }
                }
                let length = Int(field("content-length") ?? "0") ?? 0
                guard buffer.count >= end.upperBound - buffer.startIndex + length else { break }
                buffer = Data(buffer[(end.upperBound + length)...])
                let line = headers.first ?? ""
                lock.withLock { lines.append(line) }
                let path = line.split(separator: " ").dropFirst().first.map(String.init) ?? ""
                if silent.contains(path) { continue }
                if let key = field("sec-websocket-key") {
                    let protocols = field("sec-websocket-protocol") ?? ""
                    lock.withLock { offered.append(protocols) }
                    if let status = refuseUpgrades {
                        connection.send(content: Data("HTTP/1.1 \(status) Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8),
                                        completion: .contentProcessed { _ in connection.cancel() })
                        return
                    }
                    let echoed = protocols.split(separator: ",").first.map { "Sec-WebSocket-Protocol: \($0.trimmingCharacters(in: .whitespaces))\r\n" } ?? ""
                    let digest = Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))
                    let accept = Data(digest).base64EncodedString()
                    connection.send(content: Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\(echoed)\r\n".utf8),
                                    completion: .contentProcessed { _ in })
                    return // The socket stays open; nothing more is read from it.
                }
                connection.send(content: Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}".utf8),
                                completion: .contentProcessed { _ in })
            }
            if complete { return }
            self.read(connection, buffer: buffer)
        }
    }
}
