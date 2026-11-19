import CryptoKit
import Foundation

/// Opens one RFC 8291 push message: the `aes128gcm` content coding of RFC 8188 with the key
/// derived from the phone's P-256 key and auth secret. Pure: bytes in, plaintext or nil out.
/// Every malformed, truncated, tampered or foreign message is nil; nothing here throws or logs.
enum PushCrypto {
    /// The gateway refuses bodies over 2,800 bytes; anything much larger isn't ace's.
    static let maxBody = 4096
    /// RFC 8188 §2.1: salt (16), record size (4), key id length (1).
    private static let headerLength = 21
    /// RFC 8291 §4: the key id is the sender's uncompressed P-256 point.
    private static let pointLength = 65
    private static let tagLength = 16

    static func decrypt(_ body: Data, key: PushKey) -> Data? {
        let bytes = [UInt8](body)
        guard bytes.count <= maxBody, bytes.count >= headerLength else { return nil }
        let salt = Data(bytes[0..<16])
        let recordSize = bytes[16..<20].reduce(0) { $0 << 8 | Int($1) }
        let idLength = Int(bytes[20])
        guard idLength == pointLength, bytes.count >= headerLength + idLength + tagLength + 1 else { return nil }
        let senderPoint = Data(bytes[headerLength..<headerLength + idLength])
        let record = Data(bytes[(headerLength + idLength)...])
        // RFC 8291 §4: one record, smaller than the record size. RFC 8188 §2: rs is at least 18.
        guard recordSize >= 18, record.count <= recordSize else { return nil }
        guard let sender = try? P256.KeyAgreement.PublicKey(x963Representation: senderPoint),
              let shared = try? key.privateKey.sharedSecretFromKeyAgreement(with: sender) else { return nil }
        let secret = shared.withUnsafeBytes { Data($0) }

        // RFC 8291 §3.3–3.4: the auth secret and ECDH secret give the input keying material,
        // bound to both public keys.
        let receiverPoint = key.privateKey.publicKey.x963Representation
        let prkKey = hmac(secret, key: key.auth)
        let ikm = hmac(Data("WebPush: info".utf8) + [0] + receiverPoint + senderPoint + [1], key: prkKey)
        // RFC 8188 §2.2–2.3: HKDF with the salt gives the content key and nonce.
        let prk = hmac(ikm, key: salt)
        let cek = hmac(Data("Content-Encoding: aes128gcm".utf8) + [0, 1], key: prk).prefix(16)
        let nonce = hmac(Data("Content-Encoding: nonce".utf8) + [0, 1], key: prk).prefix(12)

        // The first (and only) record's sequence number is 0, so the nonce is used as is.
        guard let gcmNonce = try? AES.GCM.Nonce(data: nonce),
              let box = try? AES.GCM.SealedBox(nonce: gcmNonce, ciphertext: record.dropLast(tagLength), tag: record.suffix(tagLength)),
              let padded = try? AES.GCM.open(box, using: SymmetricKey(data: cek)) else { return nil }
        return unpad(padded)
    }

    /// RFC 8188 §2: plaintext, a delimiter, then zero or more zero bytes. The last record's
    /// delimiter is 2; a 1 would promise another record, which RFC 8291 doesn't allow.
    private static func unpad(_ padded: Data) -> Data? {
        guard let end = padded.lastIndex(where: { $0 != 0 }), padded[end] == 2 else { return nil }
        return Data(padded[padded.startIndex..<end])
    }
    private static func hmac(_ data: Data, key: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }
}

extension Data {
    /// RFC 4648 §5, with or without padding.
    init?(base64URL text: String) {
        guard text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "=") }) else { return nil }
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 = base64.trimmingCharacters(in: CharacterSet(charactersIn: "="))
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        self.init(base64Encoded: base64)
    }
    var base64URL: String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .trimmingCharacters(in: CharacterSet(charactersIn: "="))
    }
}
