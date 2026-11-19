import CryptoKit
import Foundation

/// The paired credential this install also holds on a machine it reaches through its account
/// relay (ADR 0115): that pairing's device id and the Keychain key of its token.
struct LinkedPairing: Sendable, Equatable {
    let deviceId: String
    let secretKey: String
}

/// Proof, for an account hello, that this install holds the paired credential of device
/// `deviceId` on that machine, so the daemon treats both ids as one device for command receipts.
/// The token itself never goes over the relay: the proof is an HMAC keyed by the token's digest,
/// which is all the daemon keeps of it.
struct PairingLinkProof: Encodable, Sendable, Equatable {
    let deviceId: String
    let proof: String

    /// base64url (no padding) HMAC-SHA256 of `ace-link/v1\n<paired>\n<account>`, keyed by the
    /// UTF-8 lowercase hex SHA-256 of the paired device token.
    init(token: String, pairedDeviceId: String, accountDeviceId: String) {
        let digest = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
        let message = Data("ace-link/v1\n\(pairedDeviceId)\n\(accountDeviceId)".utf8)
        let mac = HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: Data(digest.utf8)))
        deviceId = pairedDeviceId
        proof = Data(mac).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// The proof an account route's hello carries: none for a direct route, an account machine
    /// this install never paired, or a pairing whose token isn't in the Keychain.
    static func of(_ target: ConnectionTarget, secrets: any SecretStore) -> PairingLinkProof? {
        guard target.relay != nil, let pairing = target.linkedPairing,
              let token = (try? secrets.get(pairing.secretKey)) ?? nil, !token.isEmpty else { return nil }
        return PairingLinkProof(token: token, pairedDeviceId: pairing.deviceId, accountDeviceId: target.deviceId)
    }
}
