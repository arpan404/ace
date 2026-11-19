import CryptoKit
import Foundation

/// The phone's RFC 8291 key: a P-256 key pair and a 16-byte auth secret. Machines get only the
/// public half and the secret (`p256dh`, `auth`) and encrypt each alert to them; the private
/// half never leaves the phone.
struct PushKey: Sendable {
    let privateKey: P256.KeyAgreement.PrivateKey
    let auth: Data

    static func generate() -> PushKey {
        var secret = SystemRandomNumberGenerator()
        return PushKey(privateKey: P256.KeyAgreement.PrivateKey(), auth: Data((0..<16).map { _ in UInt8.random(in: 0...255, using: &secret) }))
    }
    /// The uncompressed public point, base64url (65 bytes).
    var p256dh: String { privateKey.publicKey.x963Representation.base64URL }
    var authSecret: String { auth.base64URL }
}

/// Keeps the push key in a file in the app group container, written by the app and read by the
/// Notification Service Extension.
///
/// A file rather than the keychain: an extension shares keychain items only through a
/// `keychain-access-groups` entitlement prefixed with the signing team, which the ad-hoc
/// simulator signing and free personal teams can't give reliably, while the app group is
/// already shared by every target. The file is written with complete-until-first-unlock
/// protection, so the extension can read it on a locked phone after the first unlock since boot
/// (ADR 0106), mode 0600, and excluded from backups: a restored phone makes a new key and
/// registers it again, rather than carrying the old one to another device.
struct PushKeyStore: Sendable {
    let file: URL

    init(directory: URL) { file = directory.appendingPathComponent("push-key.json") }
    /// The app group's store; nil when the container is unavailable (an unsigned build).
    static var appGroup: PushKeyStore? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.ace.ios")
            .map { PushKeyStore(directory: $0.appendingPathComponent("Push", isDirectory: true)) }
    }

    /// The extension's read: never creates one, so a missing key keeps the generic text.
    func read() -> PushKey? {
        guard let data = try? Data(contentsOf: file), data.count < 1024,
              let stored = try? JSONDecoder().decode(Stored.self, from: data),
              let raw = Data(base64URL: stored.privateKey), let auth = Data(base64URL: stored.auth), auth.count == 16,
              let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw) else { return nil }
        return PushKey(privateKey: key, auth: auth)
    }
    /// The app's read: the stored key, or a new one written first.
    func loadOrCreate() throws -> PushKey {
        if let key = read() { return key }
        let key = PushKey.generate()
        let directory = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(Stored(privateKey: key.privateKey.rawRepresentation.base64URL, auth: key.auth.base64URL))
        #if os(iOS)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: file, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        var url = file
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        return key
    }
    private struct Stored: Codable { let privateKey: String; let auth: String }
}
