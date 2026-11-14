import CryptoKit
import Foundation
import Testing
import UserNotifications
@testable import Ace

/// The Node-made vectors (`Tests/Fixtures/push-alerts.json`).
struct PushVectors: Decodable {
    struct Receiver: Decodable { let privateKey: String; let p256dh: String; let auth: String }
    struct Case: Decodable { let name: String; let plaintext: String; let apns: PushJSONValue }
    struct Push {
        let plaintext: String
        var userInfo: [AnyHashable: Any]
        var ciphertext: Data {
            get { PushAlert.ciphertext(userInfo) ?? Data() }
            set { userInfo["ace"] = ["v": 1, "c": newValue.base64URL] }
        }
        var content: UNNotificationContent {
            let content = UNMutableNotificationContent()
            content.title = "ace"; content.body = "New activity"
            content.interruptionLevel = (userInfo["aps"] as? [String: Any])?["interruption-level"] as? String == "passive" ? .passive : .active
            content.userInfo = userInfo
            return content
        }
    }
    let receiver: Receiver
    let cases: [Case]
    var p256dh: String { receiver.p256dh }
    var auth: String { receiver.auth }

    static func load() throws -> PushVectors {
        let url = try #require(Bundle(for: VectorsToken.self).url(forResource: "push-alerts", withExtension: "json"))
        return try JSONDecoder().decode(PushVectors.self, from: Data(contentsOf: url))
    }
    func key() throws -> PushKey {
        let raw = try #require(Data(base64URL: receiver.privateKey))
        return PushKey(privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: raw), auth: try #require(Data(base64URL: receiver.auth)))
    }
    func push(_ name: String) throws -> Push {
        let found = try #require(cases.first { $0.name == name })
        let info = try #require(found.apns.object as? [AnyHashable: Any])
        return Push(plaintext: found.plaintext, userInfo: info)
    }
}
private final class VectorsToken {}

/// Any JSON, read back as Foundation objects, the way APNs hands `userInfo` to the extension.
struct PushJSONValue: Decodable {
    let object: Any
    init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode([String: PushJSONValue].self) { object = value.mapValues(\.object) }
        else if let value = try? container.decode([PushJSONValue].self) { object = value.map(\.object) }
        else if let value = try? container.decode(Int.self) { object = value }
        else if let value = try? container.decode(String.self) { object = value }
        else if let value = try? container.decode(Bool.self) { object = value }
        else { object = NSNull() }
    }
}

/// The sending half of RFC 8291 for plaintext the daemon's vectors don't cover. Written from the
/// RFC's steps, separately from `PushCrypto`'s reading; the Node vectors pin both to the daemon.
enum PushSealer {
    static func seal(_ plaintext: Data, to key: PushKey) throws -> Data {
        let sender = P256.KeyAgreement.PrivateKey()
        let receiver = key.privateKey.publicKey
        let shared = try sender.sharedSecretFromKeyAgreement(with: receiver).withUnsafeBytes { Data($0) }
        let salt = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
        let prkKey = Data(HMAC<SHA256>.authenticationCode(for: shared, using: SymmetricKey(data: key.auth)))
        let info = Data("WebPush: info".utf8) + [0] + receiver.x963Representation + sender.publicKey.x963Representation + [1]
        let ikm = Data(HMAC<SHA256>.authenticationCode(for: info, using: SymmetricKey(data: prkKey)))
        let prk = Data(HMAC<SHA256>.authenticationCode(for: ikm, using: SymmetricKey(data: salt)))
        let cek = Data(HMAC<SHA256>.authenticationCode(for: Data("Content-Encoding: aes128gcm".utf8) + [0, 1], using: SymmetricKey(data: prk))).prefix(16)
        let nonce = Data(HMAC<SHA256>.authenticationCode(for: Data("Content-Encoding: nonce".utf8) + [0, 1], using: SymmetricKey(data: prk))).prefix(12)
        let box = try AES.GCM.seal(plaintext + [2], using: SymmetricKey(data: cek), nonce: AES.GCM.Nonce(data: nonce))
        var header = salt
        header += [0, 0, 0x10, 0] // rs 4096
        header += [65] + sender.publicKey.x963Representation
        return header + box.ciphertext + box.tag
    }
}

/// `text` encrypted to `key` by the phone's own reading of RFC 8291 run backwards, wrapped
/// as the gateway wraps it. For plaintext the daemon would never send.
func sealedPush(_ text: String, to key: PushKey) throws -> UNNotificationContent {
    let content = UNMutableNotificationContent()
    content.title = "ace"; content.body = "New activity"
    content.userInfo = ["aps": ["mutable-content": 1], "ace": ["v": 1, "c": try PushSealer.seal(Data(text.utf8), to: key).base64URL]]
    return content
}
/// A notification's `userInfo` as the string keys and values ace puts in it.
func stringValues(_ info: [AnyHashable: Any]) -> [String: String] {
    var out: [String: String] = [:]
    for (key, value) in info { if let key = key as? String, let value = value as? String { out[key] = value } }
    return out
}
