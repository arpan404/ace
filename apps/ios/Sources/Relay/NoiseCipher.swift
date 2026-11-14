import CryptoKit
import Foundation

enum NoiseError: Error, Equatable {
    case closed, turn, size, decrypt, exhausted, pin, missingKey, invalidKey
}

/// The largest Noise message (revision 34), handshake or transport.
let noiseMaxMessage = 65_535

/// Noise's CipherState: ChaChaPoly with a 64-bit little-endian counter nonce. Ordered; each
/// direction owns one and rekeys in step with its peer.
struct NoiseCipher: Sendable {
    private var key: SymmetricKey?
    private(set) var nonce: UInt64
    private var closed = false

    init(key: Data? = nil, nonce: UInt64 = 0) {
        self.key = key.map { SymmetricKey(data: $0) }
        self.nonce = nonce
    }
    var hasKey: Bool { key != nil }

    private static func nonceBytes(_ n: UInt64) -> ChaChaPoly.Nonce {
        var bytes = Data(count: 4)
        withUnsafeBytes(of: n.littleEndian) { bytes.append(contentsOf: $0) }
        // 12 bytes always form a valid nonce.
        return try! ChaChaPoly.Nonce(data: bytes)
    }
    private mutating func check(_ length: Int) throws {
        if closed || nonce == UInt64.max { destroy(); throw NoiseError.exhausted }
        if length > noiseMaxMessage { throw NoiseError.size }
    }
    mutating func encrypt(_ plaintext: Data, ad: Data = Data()) throws -> Data {
        try check(plaintext.count + (key == nil ? 0 : 16))
        guard let key else { return plaintext }
        let box = try ChaChaPoly.seal(plaintext, using: key, nonce: Self.nonceBytes(nonce), authenticating: ad)
        nonce += 1
        // `ciphertext` is a slice of the sealed box (it starts at index 12): copy it, so callers
        // get bytes indexed from 0.
        var out = Data(box.ciphertext)
        out.append(box.tag)
        return out
    }
    mutating func decrypt(_ ciphertext: Data, ad: Data = Data()) throws -> Data {
        try check(ciphertext.count)
        guard let key else { return ciphertext }
        guard ciphertext.count >= 16 else { throw NoiseError.decrypt }
        let body = ciphertext.prefix(ciphertext.count - 16), tag = ciphertext.suffix(16)
        do {
            let box = try ChaChaPoly.SealedBox(nonce: Self.nonceBytes(nonce), ciphertext: body, tag: tag)
            let plain = try ChaChaPoly.open(box, using: key, authenticating: ad)
            nonce += 1
            return plain
        } catch { throw NoiseError.decrypt }
    }
    /// REKEY(k): the first 32 bytes of encrypting 32 zeros at the reserved nonce 2^64-1.
    mutating func rekey() throws {
        try check(0)
        guard let key else { throw NoiseError.missingKey }
        let box = try ChaChaPoly.seal(Data(count: 32), using: key, nonce: Self.nonceBytes(.max), authenticating: Data())
        self.key = SymmetricKey(data: box.ciphertext.prefix(32))
    }
    mutating func destroy() {
        key = nil
        closed = true
    }
}
