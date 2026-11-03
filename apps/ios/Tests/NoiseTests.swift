import Foundation
import Testing
@testable import Ace

/// The native Noise XX against the same official vectors the TypeScript one passes
/// (`packages/secure-channel/fixtures`), and the relay stream's pinning.
@Suite struct NoiseTests {
    private struct Fixture: Decodable {
        struct Vector: Decodable {
            struct Message: Decodable { let payload: String; let ciphertext: String }
            let init_prologue: String, init_static: String, init_ephemeral: String
            let resp_prologue: String, resp_static: String, resp_ephemeral: String
            let handshake_hash: String?
            let messages: [Message]
        }
        let vectors: [Vector]
    }
    private static func vectors(_ name: String) throws -> [Fixture.Vector] {
        let url = try #require(Bundle(for: BundleToken.self).url(forResource: name, withExtension: "json"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url)).vectors
    }

    @Test(arguments: ["cacophony", "snow"])
    func matchesEveryHandshakeAndTransportByteOfTheOfficialVectors(_ source: String) throws {
        let vectors = try Self.vectors(source)
        #expect(!vectors.isEmpty)
        for v in vectors {
            var a = NoiseXX(initiator: true, staticKey: try NoiseKeys(privateKey: hexData(v.init_static)),
                            ephemeralKey: try NoiseKeys(privateKey: hexData(v.init_ephemeral)), prologue: hexData(v.init_prologue))
            var b = NoiseXX(initiator: false, staticKey: try NoiseKeys(privateKey: hexData(v.resp_static)),
                            ephemeralKey: try NoiseKeys(privateKey: hexData(v.resp_ephemeral)), prologue: hexData(v.resp_prologue))
            for i in 0..<3 {
                let m = v.messages[i]
                let ciphertext = i % 2 == 0 ? try a.writeMessage(hexData(m.payload)) : try b.writeMessage(hexData(m.payload))
                #expect(ciphertext.hexString == m.ciphertext)
                let plain = i % 2 == 0 ? try b.readMessage(ciphertext) : try a.readMessage(ciphertext)
                #expect(plain.hexString == m.payload)
            }
            var ta = try #require(a.transport), tb = try #require(b.transport)
            if let hash = v.handshake_hash { #expect(ta.handshakeHash.hexString == hash) }
            #expect(ta.handshakeHash == tb.handshakeHash)
            for (i, m) in v.messages.enumerated().dropFirst(3) {
                let fromA = i % 2 == 0
                let ciphertext = fromA ? try ta.send.encrypt(hexData(m.payload)) : try tb.send.encrypt(hexData(m.payload))
                #expect(ciphertext.hexString == m.ciphertext)
                let plain = fromA ? try tb.receive.decrypt(ciphertext) : try ta.receive.decrypt(ciphertext)
                #expect(plain.hexString == m.payload)
            }
        }
    }

    @Test func aHostIdIsTheSameBase32FingerprintTheDaemonAndRelayUse() throws {
        // Reference from `fingerprint()` in @ace/secure-channel for the key 09 repeated 32 times.
        let keys = try NoiseKeys(privateKey: Data(repeating: 9, count: 32))
        #expect(keys.publicKey.hexString == "57db4b359f23ae5e146e4e2512056704722506348c150c14753d0c933d04d421")
        #expect(NoiseFingerprint.of(keys.publicKey) == "A4IOPXUIEEM6GMLBBSWHEDA3CUUI64AG6CB4CALXPPRXWGPSVCRQ")
        #expect(NoiseFingerprint.isHostId("A4IOPXUIEEM6GMLBBSWHEDA3CUUI64AG6CB4CALXPPRXWGPSVCRQ"))
        #expect(!NoiseFingerprint.isHostId("a4iopxuieem6gmlbbswheda3cuui64ag6cb4calxpprxwgpsvcrq"))
    }

    @Test func theHandshakeStopsBeforeSendingAnythingWhenAnotherMachineAnswersForThePinnedHostId() throws {
        let host = NoiseKeys.generate(), impostor = NoiseKeys.generate()
        var phone = NoiseXX(initiator: true, staticKey: .generate(), ephemeralKey: .generate(),
                            pinnedFingerprint: NoiseFingerprint.of(host.publicKey))
        var answer = NoiseXX(initiator: false, staticKey: impostor, ephemeralKey: .generate())
        _ = try answer.readMessage(try phone.writeMessage())
        #expect(throws: NoiseError.pin) { try phone.readMessage(try answer.writeMessage()) }
        #expect(throws: NoiseError.closed) { try phone.writeMessage() }
        #expect(phone.transport == nil)
    }

    @Test func tamperedReplayedAndReorderedCiphertextFailWithoutAdvancingTheReceiver() throws {
        var (a, b) = try noisePair()
        let first = try a.send.encrypt(Data([1])), second = try a.send.encrypt(Data([2]))
        var corrupt = first; corrupt[0] ^= 1
        #expect(throws: NoiseError.decrypt) { try b.receive.decrypt(corrupt) }
        #expect(throws: NoiseError.decrypt) { try b.receive.decrypt(second) }
        #expect(try b.receive.decrypt(first) == Data([1]))
        #expect(throws: NoiseError.decrypt) { try b.receive.decrypt(first) }
        #expect(try b.receive.decrypt(second) == Data([2]))
    }

    @Test func aCoordinatedRekeyMatchesTheReferenceCiphertextAndRetiresTheOldKey() throws {
        let key = Data(repeating: 7, count: 32)
        var a = NoiseCipher(key: key), b = NoiseCipher(key: key), old = NoiseCipher(key: key)
        _ = try b.decrypt(try a.encrypt(Data([1])))
        var spare = NoiseCipher(key: key)
        _ = try old.decrypt(try spare.encrypt(Data([1])))
        try a.rekey(); try b.rekey()
        let message = try a.encrypt(Data([2]))
        // The same reference the TypeScript suite checks (Node/OpenSSL).
        #expect(message.hexString == "acc100689abe3692f6d7cccfd594fc119c")
        #expect(throws: NoiseError.decrypt) { try old.decrypt(message) }
        #expect(try b.decrypt(message) == Data([2]))
    }

    @Test func theLargestTransportMessageFitsAndOneByteMoreIsRefused() throws {
        var (a, b) = try noisePair()
        let message = try a.send.encrypt(Data(count: 65_519))
        #expect(message.count == 65_535)
        #expect(try b.receive.decrypt(message).count == 65_519)
        #expect(throws: NoiseError.size) { try a.send.encrypt(Data(count: 65_520)) }
    }
}

/// Two finished transports, phone first.
func noisePair(pinned: Bool = true) throws -> (NoiseTransport, NoiseTransport) {
    let host = NoiseKeys.generate()
    var a = NoiseXX(initiator: true, staticKey: .generate(), ephemeralKey: .generate(),
                    prologue: Data("ace daemon relay stream v1".utf8),
                    pinnedFingerprint: pinned ? NoiseFingerprint.of(host.publicKey) : nil)
    var b = NoiseXX(initiator: false, staticKey: host, ephemeralKey: .generate(), prologue: Data("ace daemon relay stream v1".utf8))
    _ = try b.readMessage(try a.writeMessage())
    _ = try a.readMessage(try b.writeMessage())
    _ = try b.readMessage(try a.writeMessage())
    return (try #require(a.transport), try #require(b.transport))
}
func hexData(_ text: String) -> Data {
    var data = Data(capacity: text.count / 2)
    var index = text.startIndex
    while index < text.endIndex {
        let next = text.index(index, offsetBy: 2)
        data.append(UInt8(text[index..<next], radix: 16) ?? 0)
        index = next
    }
    return data
}
extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
private final class BundleToken {}
