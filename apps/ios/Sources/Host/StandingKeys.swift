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
    func delete(tag: String)
}

/// The keys this phone proves the person's standing with on its paired machines (ADR 0190 §7):
/// one per machine, made at pairing, its private half never leaving the vault. The daemon learns
/// the public half when the phone redeems a link, and a person's link gives that device the
/// person's standing, proven on each socket with `sign`. JavaScript only ever sees the public
/// half and signatures.
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
        guard point.count == 65, point.first == 0x04 else { vault.delete(tag: tag); return nil }
        return (tag, Self.base64url(point))
    }
    /// The pairing that made `tag` succeeded with `hostId`: it proves with that key from now on,
    /// and the key an earlier pairing of the machine kept goes.
    func keep(tag: String, for hostId: String) throws {
        let earlier = try names.get(hostId)
        try names.set(hostId, tag)
        if let earlier, earlier != tag { vault.delete(tag: earlier) }
    }
    /// The pairing that made `tag` didn't happen: nothing names its key.
    func discard(tag: String) { vault.delete(tag: tag) }
    /// The machine was removed from this phone: its key goes with it.
    func forget(hostId: String) {
        if let tag = try? names.get(hostId) { vault.delete(tag: tag) }
        try? names.delete(hostId)
    }
    /// The machine's key's signature over `text`, IEEE P1363 base64url, as a socket's
    /// `device.standing` proof. Only `pairedStandingText` for this device is signed: the script
    /// can't make the key sign anything else. Throws when the phone holds no key for the machine.
    func sign(_ text: String, hostId: String, deviceId: String) throws -> String {
        guard Self.isPairedProof(text, deviceId: deviceId), let tag = try names.get(hostId) else { throw HostError.unsupported }
        let der = try vault.sign(tag: tag, message: Data(text.utf8))
        return Self.base64url(try P256.Signing.ECDSASignature(derRepresentation: der).rawRepresentation)
    }
    /// `ace-paired-standing/v1\n<host>\n<nonce>\n<binding>\n<deviceId>` (`pairedStandingText`),
    /// naming this device, each part a single bounded line.
    static func isPairedProof(_ text: String, deviceId: String) -> Bool {
        guard text.utf8.count <= 2048 else { return false }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count == 5, lines[0] == "ace-paired-standing/v1", lines[4] == deviceId else { return false }
        return lines[1...3].allSatisfy { !$0.isEmpty && $0.utf8.count <= 512 }
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
            delete(tag: tag)
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
    func delete(tag: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: Data(tag.utf8)]
        SecItemDelete(query as CFDictionary)
    }
}
