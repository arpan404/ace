import CryptoKit
import Foundation

/// The keys this phone proves a member's standing with on an organization's hosts (ADR 0206
/// §2.2): one per host, made the first time the phone connects to it, its private half never
/// leaving the vault. A member grant names the key's public half, and each socket's proof is its
/// signature over that socket's challenge and the grant, so a grant taken on the way proves
/// nothing without this phone.
struct MemberKeys: Sendable {
    var vault: any StandingKeyVault = SecureEnclaveVault()
    /// Each host's key: its tag and public half (`tag publicKey`), kept in the Keychain beside it.
    var names: any SecretStore = KeychainSecrets(service: "app.ace.ios.member-key")
    var newTag: @Sendable () -> String = { "app.ace.ios.member.\(UUID().uuidString)" }

    /// The public half (base64url, uncompressed P-256) of the host's key, made now if the phone has
    /// none. Nil where the phone can't make one (no Secure Enclave, as in the Simulator).
    func publicKey(for hostId: String) -> String? {
        if let kept = kept(hostId) { return kept.publicKey }
        let tag = newTag()
        guard let point = try? vault.create(tag: tag), point.count == 65, point.first == 0x04 else {
            try? vault.delete(tag: tag)
            return nil
        }
        let publicKey = StandingKeys.base64url(point)
        do { try names.set(hostId, "\(tag) \(publicKey)") } catch {
            try? vault.delete(tag: tag)
            return nil
        }
        return publicKey
    }

    /// The host's key's signature over `standingProofText` for one socket (IEEE P1363, base64url):
    /// `account.standing`'s proof. Throws when the phone holds no key for the host, or a field
    /// isn't one canonical line.
    func proof(host: String, nonce: String, binding: String?, grant: String, hostId: String) throws -> String {
        guard let text = Self.standingText(host: host, nonce: nonce, binding: binding, grant: grant),
              let kept = kept(hostId) else { throw HostError.unsupported }
        let der = try vault.sign(tag: kept.tag, message: Data(text.utf8))
        return StandingKeys.base64url(try P256.Signing.ECDSASignature(derRepresentation: der).rawRepresentation)
    }

    /// The host is no longer one of the person's organizations': its key goes.
    func forget(hostId: String) throws {
        guard let kept = kept(hostId) else { return }
        try vault.delete(tag: kept.tag)
        try names.delete(hostId)
    }

    /// `ace-standing/v2\n<host>\n<nonce>\n<binding>\n<grant>`, as `standingProofText`
    /// (`@ace/account-grant`) writes it, with `none` for a socket without a channel binding. Nil
    /// unless every field is printable ASCII without spaces (a grant up to 2048 bytes, the rest up
    /// to 512): no CR, LF or other control character can reshape the lines.
    static func standingText(host: String, nonce: String, binding: String?, grant: String) -> String? {
        let fields = [host, nonce, binding ?? "none"]
        guard fields.allSatisfy({ canonical($0, limit: 512) }), canonical(grant, limit: 2048) else { return nil }
        return (["ace-standing/v2"] + fields + [grant]).joined(separator: "\n")
    }
    private static func canonical(_ field: String, limit: Int) -> Bool {
        let bytes = field.utf8
        return (1...limit).contains(bytes.count) && bytes.allSatisfy { (0x21...0x7E).contains($0) }
    }

    private func kept(_ hostId: String) -> (tag: String, publicKey: String)? {
        guard let line = (try? names.get(hostId)).flatMap({ $0 }) else { return nil }
        let parts = line.split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, parts[1].utf8.count == 87 else { return nil }
        return (String(parts[0]), String(parts[1]))
    }
}
