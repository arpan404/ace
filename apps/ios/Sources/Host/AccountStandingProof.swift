import CryptoKit
import Foundation

/// The key a runtime's relayed sockets prove the person's standing with (ADR 0190 §3): a P-256
/// key made for that runtime and kept in its memory only, like a browser window's. A person's
/// grant names its public half, and each socket's proof is its signature, so a grant read on the
/// way proves nothing without this phone.
protocol AccountStandingKey: Sendable {
    /// The uncompressed P-256 point, base64url (87 characters): the grant request's `key`.
    var publicKey: String { get }
    /// ECDSA P-256 with SHA-256 over `message`, IEEE P1363 (64 bytes).
    func sign(_ message: Data) throws -> Data
}

/// A runtime's standing key: in the Secure Enclave where the phone has one, so even this app's
/// memory never holds its private half, and a software key in memory elsewhere (the Simulator).
/// Neither is ever stored; a new runtime makes a new one.
struct DeviceStandingKey: AccountStandingKey {
    private enum Held: @unchecked Sendable {
        case enclave(SecureEnclave.P256.Signing.PrivateKey)
        case software(P256.Signing.PrivateKey)
    }
    private let held: Held
    let publicKey: String

    private init(_ held: Held, point: Data) {
        self.held = held
        publicKey = StandingKeys.base64url(point)
    }
    static func make() -> DeviceStandingKey {
        if SecureEnclave.isAvailable, let key = try? SecureEnclave.P256.Signing.PrivateKey() {
            return DeviceStandingKey(.enclave(key), point: key.publicKey.x963Representation)
        }
        let key = P256.Signing.PrivateKey()
        return DeviceStandingKey(.software(key), point: key.publicKey.x963Representation)
    }
    func sign(_ message: Data) throws -> Data {
        switch held {
        case .enclave(let key): return try key.signature(for: message).rawRepresentation
        case .software(let key): return try key.signature(for: message).rawRepresentation
        }
    }
}

/// One relayed socket's proof of the person's standing (ADR 0190 §3), built natively so the
/// script can't choose what is signed: the challenge comes from the welcome that arrived on this
/// very socket, and the binding from this socket's own Noise handshake. Pure: `RelaySocket`
/// drives it, with the person's grant `AccountGrants.personGrant` fetched for it.
enum AccountStandingProof {
    struct Challenge: Equatable, Sendable { let host: String; let nonce: String }
    private struct Welcome: Decodable { let type: String; let standingNonce: String?; let standingHost: String? }

    /// The challenge a welcome sets this socket, when the daemon asks for one and names the host
    /// the relay pinned this channel to; nil otherwise (an older daemon asks for none).
    static func challenge(welcome text: String, hostId: String) -> Challenge? {
        guard let welcome = try? JSONDecoder().decode(Welcome.self, from: Data(text.utf8)), welcome.type == "welcome",
              let host = welcome.standingHost, let nonce = welcome.standingNonce, host == hostId else { return nil }
        return Challenge(host: host, nonce: nonce)
    }
    /// The relayed socket's channel binding: its Noise handshake hash, base64url, as the daemon
    /// derives it from its own end of the stream.
    static func binding(handshakeHash: Data) -> String { StandingKeys.base64url(handshakeHash) }

    /// `ace-standing/v2\n<host>\n<nonce>\n<binding>\n<grant>`, as `standingProofText` writes it.
    /// Nil unless every field is printable ASCII without spaces (the grant up to 2048 bytes, the
    /// rest up to 512), so no CR, LF or other control character can reshape the lines.
    static func text(_ challenge: Challenge, binding: String, grant: String) -> String? {
        let short = [challenge.host, challenge.nonce, binding]
        guard short.allSatisfy({ isCanonical($0, limit: 512) }), isCanonical(grant, limit: 2048) else { return nil }
        return (["ace-standing/v2"] + short + [grant]).joined(separator: "\n")
    }
    /// The `account.standing` message for `challenge`: `key`'s signature over its text. Nil when
    /// a field isn't canonical or the key can't sign.
    static func message(_ challenge: Challenge, binding: String, grant: String, key: any AccountStandingKey,
                        requestId: String) -> String? {
        guard let text = text(challenge, binding: binding, grant: grant),
              let signature = try? key.sign(Data(text.utf8)), signature.count == 64,
              let data = try? JSONSerialization.data(
                  withJSONObject: ["type": "account.standing", "requestId": requestId, "grant": grant,
                                   "proof": StandingKeys.base64url(signature)],
                  options: [.sortedKeys, .withoutEscapingSlashes]) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }
    private static func isCanonical(_ field: String, limit: Int) -> Bool {
        let bytes = field.utf8
        return (1...limit).contains(bytes.count) && bytes.allSatisfy { (0x21...0x7E).contains($0) }
    }
}

/// The daemon's verdict when `text` answers the proof sent as `requestId`; nil for every other
/// message. A member's standing on an org host (ADR 0206, `member`) is never the person's. Pure.
enum StandingVerdict {
    static func read(_ text: String, requestId: String) -> PairedStanding? {
        guard text.hasPrefix(#"{"type":"account.standing.result""#),
              let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              object["requestId"] as? String == requestId else { return nil }
        let result = object["result"] as? [String: Any]
        return result?["ok"] as? Bool == true && result?["member"] == nil ? .proven : .missing
    }

    /// When a proven verdict's standing ends, as the daemon reports it (`until`, epoch
    /// milliseconds); nil for a refusal or for any other message.
    static func until(_ text: String, requestId: String) -> Date? {
        guard read(text, requestId: requestId) == .proven,
              let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let result = object["result"] as? [String: Any], let millis = result["until"] as? Double else { return nil }
        return Date(timeIntervalSince1970: millis / 1000)
    }
    /// Seconds from `now` until `until`; zero once it has passed.
    static func wait(until: Date, now: Date) -> TimeInterval { max(0, until.timeIntervalSince(now)) }
    /// Seconds before an expiry that a proof is renewed, so a renewal can still arrive in time.
    static let lead: TimeInterval = 30
    /// When to prove again: `interval` from now, or `lead` before the standing ends if that is
    /// sooner. A standing too short to leave a lead is renewed halfway, never at once, so a
    /// short one can't make the socket prove in a loop.
    static func renewal(remaining: TimeInterval, interval: TimeInterval) -> TimeInterval {
        remaining > 2 * lead ? min(interval, remaining - lead) : remaining / 2
    }
}
