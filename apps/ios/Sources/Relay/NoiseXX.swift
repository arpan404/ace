import CryptoKit
import Foundation

/// An X25519 key pair as raw bytes. Production keys come from `NoiseKeys.generate()`.
struct NoiseKeys: Sendable {
    let privateKey: Curve25519.KeyAgreement.PrivateKey
    var publicKey: Data { privateKey.publicKey.rawRepresentation }

    init(privateKey raw: Data) throws {
        guard raw.count == 32 else { throw NoiseError.invalidKey }
        privateKey = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: raw)
    }
    private init(_ key: Curve25519.KeyAgreement.PrivateKey) { privateKey = key }
    static func generate() -> NoiseKeys { NoiseKeys(.init()) }
}

/// Both directions of a finished handshake, and who answered.
struct NoiseTransport: Sendable {
    var send: NoiseCipher
    var receive: NoiseCipher
    let handshakeHash: Data
    let remoteStatic: Data
}

/// Noise revision 34, `Noise_XX_25519_ChaChaPoly_SHA256`: -> e; <- e, ee, s, es; -> s, se.
/// The relay's stream handshake runs it with empty payloads; the phone is always initiator.
struct NoiseXX: Sendable {
    private let initiator: Bool
    private let pinnedFingerprint: String?
    private let s: NoiseKeys
    private let e: NoiseKeys
    private var rs: Data?
    private var re: Data?
    private var h: Data
    private var ck: Data
    private var cipher = NoiseCipher()
    private var step = 0
    private var failed = false
    private(set) var transport: NoiseTransport?

    init(initiator: Bool, staticKey: NoiseKeys, ephemeralKey: NoiseKeys, prologue: Data = Data(), pinnedFingerprint: String? = nil) {
        self.initiator = initiator
        self.pinnedFingerprint = pinnedFingerprint
        s = staticKey; e = ephemeralKey
        var name = Data("Noise_XX_25519_ChaChaPoly_SHA256".utf8)
        name.append(Data(count: 32 - name.count))
        h = name; ck = name
        mixHash(prologue)
    }

    private mutating func mixHash(_ data: Data) {
        var hasher = SHA256()
        hasher.update(data: h); hasher.update(data: data)
        h = Data(hasher.finalize())
    }
    private mutating func mixKey(_ local: NoiseKeys, _ remote: Data?) throws {
        guard let remote else { throw NoiseError.missingKey }
        let shared = try local.privateKey.sharedSecretFromKeyAgreement(with: .init(rawRepresentation: remote))
        let (nextCk, k) = Self.derive(ck, shared.withUnsafeBytes { Data($0) })
        ck = nextCk
        cipher = NoiseCipher(key: k)
    }
    /// HKDF(ck, input) with two 32-byte outputs, as RFC 5869 with salt `ck` and empty info.
    static func derive(_ ck: Data, _ input: Data) -> (Data, Data) {
        let out = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: input), salt: ck, info: Data(), outputByteCount: 64)
        let bytes = out.withUnsafeBytes { Data($0) }
        return (bytes.prefix(32), bytes.suffix(32))
    }
    private mutating func crypt(_ data: Data, writing: Bool) throws -> Data {
        let output = writing ? try cipher.encrypt(data, ad: h) : try cipher.decrypt(data, ad: h)
        mixHash(writing ? output : data)
        return output
    }
    private func check(writing: Bool) throws {
        if failed || step == 3 { throw NoiseError.closed }
        let initiatorTurn = step != 1
        if writing != (initiator == initiatorTurn) { throw NoiseError.turn }
    }
    private mutating func finish() throws {
        step += 1
        guard step == 3 else { return }
        guard let rs else { throw NoiseError.missingKey }
        let (k1, k2) = Self.derive(ck, Data())
        transport = NoiseTransport(send: NoiseCipher(key: initiator ? k1 : k2), receive: NoiseCipher(key: initiator ? k2 : k1),
                                   handshakeHash: h, remoteStatic: rs)
        cipher.destroy()
    }
    private mutating func fail(_ error: Error) -> Error {
        failed = true
        cipher.destroy()
        transport = nil
        return error
    }

    mutating func writeMessage(_ payload: Data = Data()) throws -> Data {
        try check(writing: true)
        do {
            let overhead = step == 0 ? 32 : step == 1 ? 96 : 64
            if payload.count + overhead > noiseMaxMessage { throw NoiseError.size }
            var out = Data()
            if step < 2 { out.append(e.publicKey); mixHash(e.publicKey) }
            if step == 1 {
                try mixKey(e, re)
                out.append(try crypt(s.publicKey, writing: true))
                try mixKey(s, re)
            }
            if step == 2 {
                out.append(try crypt(s.publicKey, writing: true))
                try mixKey(s, re)
            }
            out.append(try crypt(payload, writing: true))
            try finish()
            return out
        } catch { throw fail(error) }
    }

    mutating func readMessage(_ message: Data) throws -> Data {
        try check(writing: false)
        do {
            let message = Data(message)
            let minimum = step == 0 ? 32 : step == 1 ? 96 : 64
            guard message.count >= minimum, message.count <= noiseMaxMessage else { throw NoiseError.size }
            var offset = message.startIndex
            if step < 2 {
                let key = message[offset..<offset + 32]
                re = Data(key); offset += 32
                mixHash(key)
            }
            if step == 1 { try mixKey(e, re) }
            if step > 0 {
                let remote = try crypt(message[offset..<offset + 48], writing: false)
                rs = remote; offset += 48
                if let pinnedFingerprint, NoiseFingerprint.of(remote) != pinnedFingerprint { throw NoiseError.pin }
                try mixKey(e, remote)
            }
            let payload = try crypt(message[offset...], writing: false)
            try finish()
            return payload
        } catch { throw fail(error) }
    }
}

/// A host id: unpadded RFC 4648 base32 of SHA-256 of the static public key (52 characters).
enum NoiseFingerprint {
    static func of(_ publicKey: Data) -> String? {
        guard publicKey.count == 32 else { return nil }
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        var bits = 0, value = 0, result = ""
        for byte in SHA256.hash(data: publicKey) {
            value = (value << 8) | Int(byte); bits += 8
            while bits >= 5 { bits -= 5; result.append(alphabet[(value >> bits) & 31]) }
            value &= (1 << bits) - 1
        }
        if bits > 0 { result.append(alphabet[(value << (5 - bits)) & 31]) }
        return result
    }
    static func isHostId(_ value: String) -> Bool {
        value.utf8.count == 52 && value.allSatisfy { ("A"..."Z").contains($0) || ("2"..."7").contains($0) }
    }
}
