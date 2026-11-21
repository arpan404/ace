import CryptoKit
import Foundation
import Security

/// Where a standing key's private half lives and signs (ADR 0190 §7). The app's is the Secure
/// Enclave (`SecureEnclaveVault`); tests substitute a software key.
protocol StandingKeyVault: Sendable {
    /// Makes a new P-256 key under `tag` and answers its public half, uncompressed X9.63 (65 bytes).
    func create(tag: String) throws -> Data
    /// ECDSA P-256 with SHA-256 over `message` by the key under `tag`, DER encoded (X9.62).
    func sign(tag: String, message: Data) throws -> Data
    /// Deletes the key under `tag`; succeeds when there is none. Throws when it may still be there.
    func delete(tag: String) throws
}

/// The keys this phone proves the person's standing with on its paired machines (ADR 0190 §7):
/// one per machine, made at pairing, its private half never leaving the vault. Swift names the
/// public half when it redeems the link itself, and signs each socket's challenge on that
/// socket itself (`PairedStandingProof`): the script never holds the key, chooses it, or chooses
/// what it signs.
struct StandingKeys: Sendable {
    var vault: any StandingKeyVault = SecureEnclaveVault()
    /// Which key each paired machine proves with, by host id: the key's tag, not a secret, kept in
    /// the Keychain beside the key so both live and go with this device only.
    var names: any SecretStore = KeychainSecrets(service: "app.ace.ios.standing-key")
    var newTag: @Sendable () -> String = { "app.ace.ios.standing.\(UUID().uuidString)" }

    /// A new key for a pairing in progress: its tag and public half (base64url, the
    /// `standingKey` a redemption names). Nil where the phone can't make one (no Secure
    /// Enclave, as in the Simulator); it then pairs without the person's standing.
    func make() -> (tag: String, publicKey: String)? {
        let tag = newTag()
        guard let point = try? vault.create(tag: tag) else { return nil }
        guard point.count == 65, point.first == 0x04 else { discard(tag: tag); return nil }
        return (tag, Self.base64url(point))
    }
    /// The pairing that made `tag` succeeded with `hostId`: it proves with that key from now on.
    /// The key an earlier pairing of the machine kept goes first; while it can't be deleted the
    /// machine keeps naming it, so this throws and a later `keep` or `forget` tries again.
    func keep(tag: String, for hostId: String) throws {
        if let earlier = try names.get(hostId), earlier != tag { try vault.delete(tag: earlier) }
        try names.set(hostId, tag)
    }
    /// The pairing that made `tag` didn't happen. Nothing names its key, so it can sign nothing
    /// even if it outlives a failed delete; the delete is tried twice.
    func discard(tag: String) {
        if (try? vault.delete(tag: tag)) == nil { try? vault.delete(tag: tag) }
    }
    /// The machine was removed from this phone: its key goes with it. While the key can't be
    /// deleted, the machine's name for it stays, so the next `keep` or `forget` deletes it.
    func forget(hostId: String) throws {
        guard let tag = try names.get(hostId) else { return }
        try vault.delete(tag: tag)
        try names.delete(hostId)
    }
    /// The machine's key's signature over `pairedStandingText` for one socket's challenge, IEEE
    /// P1363 base64url: `device.standing`'s proof. Throws when the phone holds no key for the
    /// machine, or a field isn't one canonical line.
    func proof(host: String, nonce: String, binding: String?, deviceId: String, hostId: String) throws -> String {
        guard let text = Self.pairedText(host: host, nonce: nonce, binding: binding, deviceId: deviceId),
              let tag = try names.get(hostId) else { throw HostError.unsupported }
        let der = try vault.sign(tag: tag, message: Data(text.utf8))
        return Self.base64url(try P256.Signing.ECDSASignature(derRepresentation: der).rawRepresentation)
    }
    /// `ace-paired-standing/v1\n<host>\n<nonce>\n<binding>\n<deviceId>`, as `pairedStandingText`
    /// writes it, with `none` for a socket without a channel of its own. Nil unless every field is
    /// 1 to 512 bytes of printable ASCII without spaces: no CR, LF or other control character
    /// can reshape the lines.
    static func pairedText(host: String, nonce: String, binding: String?, deviceId: String) -> String? {
        let fields = [host, nonce, binding ?? "none", deviceId]
        guard fields.allSatisfy(isCanonicalField) else { return nil }
        return (["ace-paired-standing/v1"] + fields).joined(separator: "\n")
    }
    private static func isCanonicalField(_ field: String) -> Bool {
        let bytes = field.utf8
        return (1...512).contains(bytes.count) && bytes.allSatisfy { (0x21...0x7E).contains($0) }
    }
    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// Standing keys made in the Secure Enclave: P-256, never exportable, usable only on this
/// phone after its first unlock, so a machine's sockets can prove in the background.
struct SecureEnclaveVault: StandingKeyVault {
    func create(tag: String) throws -> Data {
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                                                           .privateKeyUsage, nil) else { throw HostError.unsupported }
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecPrivateKeyAttrs as String: [
                kSecAttrIsPermanent as String: true,
                kSecAttrApplicationTag as String: Data(tag.utf8),
                kSecAttrAccessControl as String: access,
            ] as [String: Any],
        ]
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else { throw HostError.unsupported }
        guard let point = SecKeyCopyPublicKey(key).flatMap({ SecKeyCopyExternalRepresentation($0, &error) }) else {
            try? delete(tag: tag)
            throw HostError.unsupported
        }
        return point as Data
    }
    func sign(tag: String, message: Data) throws -> Data {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: Data(tag.utf8),
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
            kSecReturnRef as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let item,
              CFGetTypeID(item) == SecKeyGetTypeID() else { throw HostError.unsupported }
        // Checked by type id above: a key reference.
        let key = unsafeDowncast(item, to: SecKey.self)
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error) else {
            throw HostError.unsupported
        }
        return signature as Data
    }
    func delete(tag: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: Data(tag.utf8)]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw HostError.storage }
    }
}
