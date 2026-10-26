import Foundation

/// What the service does with one handshake frame.
public enum LockedUseHandshakeStep: Equatable, Sendable {
    /// Send this, then wait for the daemon's next handshake frame.
    case send(LockedUseOutbound)
    /// The daemon proved it holds the token. Send this, then serve requests.
    case accepted(reply: LockedUseOutbound)
    /// Send this, then close the connection without serving anything.
    case rejected(LockedUseOutbound)
}

/// Pure mutual challenge-response over the first two daemon frames. The token itself never
/// crosses the socket, so a process that answers at the socket path first learns nothing it
/// can use, and the daemon can check the service's proof before it proves itself.
///
///     daemon:  {"v":1,"id":"h1","type":"hello","nonce":"<64 hex: 32 fresh daemon bytes>"}
///     service: {"id":"h1","nonce":"<64 hex: 32 fresh service bytes>","ok":true,
///               "proof":"<64 hex>","type":"reply","v":1}
///              proof = HMAC-SHA256(token, "ace-locked-use service proof" || 0x00 || daemonNonce || serviceNonce)
///     daemon:  checks that proof, then sends
///              {"v":1,"id":"h2","type":"prove","proof":"<64 hex>"}
///              proof = HMAC-SHA256(token, "ace-locked-use daemon proof" || 0x00 || serviceNonce || daemonNonce)
///     service: {"id":"h2","ok":true,"type":"reply","v":1}
///
/// Nonces and proofs are the raw 32 bytes in the HMAC input and 64 lowercase hex on the
/// wire. A hello that carries a `token` field is refused: that daemon would have sent its
/// secret to whatever answered. Rejections are `unauthorized` replies (or an `error` event
/// when no id is readable) and the connection closes after every one.
public struct LockedUseHandshake: Sendable {
    private enum State: Sendable { case awaitingHello, awaitingProof(daemonNonce: [UInt8]), accepted, rejected }

    private let token: LockedUseDaemonToken
    private let serviceNonce: [UInt8]
    private var state = State.awaitingHello

    /// `serviceNonce` must be 32 fresh random bytes for this connection; anything else
    /// rejects every hello.
    public init(token: LockedUseDaemonToken, serviceNonce: [UInt8]) {
        self.token = token
        self.serviceNonce = serviceNonce
    }

    public var authenticated: Bool { if case .accepted = state { return true } else { return false } }

    public mutating func receive(_ frame: Data) -> LockedUseHandshakeStep {
        switch state {
        case .awaitingHello: return hello(frame)
        case .awaitingProof(let daemonNonce): return prove(frame, daemonNonce: daemonNonce)
        case .accepted, .rejected: return reject(.anonymous)
        }
    }

    private static let denied = LockedUseWireError(code: "unauthorized",
        message: "The first frame must be a hello with a fresh nonce, then a prove with the daemon's proof.")

    private mutating func hello(_ frame: Data) -> LockedUseHandshakeStep {
        let parsed = Self.parse(frame, type: "hello")
        guard case .ok(let id, let message) = parsed else { return reject(parsed) }
        guard message["token"] == nil else {
            return reject(.failed(id, "The token is never sent over the socket; answer the challenge instead."))
        }
        guard serviceNonce.count == 32, let nonceText = message["nonce"] as? String,
              let daemonNonce = lockedUseDecodeHex32(nonceText), daemonNonce != serviceNonce else {
            return reject(.failed(id, "The hello needs a nonce of 64 lowercase hex characters."))
        }
        state = .awaitingProof(daemonNonce: daemonNonce)
        let proof = token.proof(.service, peerNonce: daemonNonce, ownNonce: serviceNonce)
        return .send(.challenge(id: id, nonce: lockedUseHex(serviceNonce), proof: lockedUseHex(proof)))
    }

    private mutating func prove(_ frame: Data, daemonNonce: [UInt8]) -> LockedUseHandshakeStep {
        let parsed = Self.parse(frame, type: "prove")
        guard case .ok(let id, let message) = parsed else { return reject(parsed) }
        guard let proof = message["proof"] as? String,
              token.verify(proof, .daemon, peerNonce: serviceNonce, ownNonce: daemonNonce) else {
            return reject(.failed(id, "The proof does not match."))
        }
        state = .accepted
        return .accepted(reply: .reply(id: id, status: nil))
    }

    private mutating func reject(_ parsed: Parsed) -> LockedUseHandshakeStep {
        state = .rejected
        switch parsed {
        case .ok, .anonymous: return .rejected(.error(Self.denied, attemptID: nil))
        case .failed(let id, let message):
            return .rejected(.failure(id: id, LockedUseWireError(code: "unauthorized", message: message)))
        case .unsupported(let id):
            return .rejected(.failure(id: id, LockedUseWireError(code: "unsupported", message: "Unsupported hello version")))
        }
    }

    private enum Parsed { case ok(String, [String: Any]), anonymous, failed(String, String), unsupported(String) }

    private static func parse(_ frame: Data, type: String) -> Parsed {
        guard let object = try? JSONSerialization.jsonObject(with: frame), let message = object as? [String: Any],
              message["type"] as? String == type,
              let id = message["id"] as? String, (1...64).contains(id.count),
              id.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }) else { return .anonymous }
        if let version = message["v"] {
            guard let number = version as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue == 1 else { return .unsupported(id) }
        }
        return .ok(id, message)
    }
}
