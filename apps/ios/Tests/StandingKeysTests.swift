import CryptoKit
import Foundation
import Testing
@testable import Ace

/// A software P-256 vault standing in for the Secure Enclave; `failDeletes` makes deletes throw.
final class SoftwareVault: StandingKeyVault, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: P256.Signing.PrivateKey] = [:]
    private var failing = false
    var tags: [String] { lock.withLock { keys.keys.sorted() } }
    var failDeletes: Bool {
        get { lock.withLock { failing } }
        set { lock.withLock { failing = newValue } }
    }
    func create(tag: String) throws -> Data {
        let key = P256.Signing.PrivateKey()
        lock.withLock { keys[tag] = key }
        return key.publicKey.x963Representation
    }
    func sign(tag: String, message: Data) throws -> Data {
        guard let key = lock.withLock({ keys[tag] }) else { throw HostError.unsupported }
        return try key.signature(for: message).derRepresentation
    }
    func delete(tag: String) throws {
        try lock.withLock {
            if failing { throw HostError.storage }
            keys.removeValue(forKey: tag)
        }
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func next() -> Int { lock.withLock { value += 1; return value } }
}

private func standingKeys(_ vault: SoftwareVault) -> StandingKeys {
    let counter = Counter()
    return StandingKeys(vault: vault, names: MemorySecrets(), newTag: { "tag-\(counter.next())" })
}
private let host = String(repeating: "H", count: 52)
private func pairedText(nonce: String = "nonce-1", binding: String = "none", device: String = "phone") -> Data {
    Data("ace-paired-standing/v1\n\(host)\n\(nonce)\n\(binding)\n\(device)".utf8)
}
private func decoded(_ base64url: String) -> Data? {
    var text = base64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while text.count % 4 != 0 { text += "=" }
    return Data(base64Encoded: text)
}
private func signature(_ proof: String) throws -> P256.Signing.ECDSASignature {
    try P256.Signing.ECDSASignature(rawRepresentation: try #require(decoded(proof)))
}
private func publicKey(_ made: (tag: String, publicKey: String)) throws -> P256.Signing.PublicKey {
    try P256.Signing.PublicKey(x963Representation: try #require(decoded(made.publicKey)))
}

@Suite struct StandingKeysTests {
    @Test func aPairedMachinesKeySignsTheCanonicalTextForOneSocketsChallenge() throws {
        let keys = standingKeys(SoftwareVault())
        let made = try #require(keys.make())
        #expect(made.publicKey.count == 87)
        try keys.keep(tag: made.tag, for: "host-studio")
        let proof = try keys.proof(host: host, nonce: "nonce-1", binding: nil, deviceId: "phone", hostId: "host-studio")
        let key = try publicKey(made)
        #expect(key.isValidSignature(try signature(proof), for: pairedText()))
        // Made for this socket's nonce and channel: it says nothing about another.
        #expect(!key.isValidSignature(try signature(proof), for: pairedText(nonce: "nonce-2")))
        #expect(!key.isValidSignature(try signature(proof), for: pairedText(binding: "channel")))
    }

    @Test func aFieldThatIsntOneCanonicalLineIsNeverSigned() throws {
        let keys = standingKeys(SoftwareVault())
        let made = try #require(keys.make())
        try keys.keep(tag: made.tag, for: "h")
        for nonce in ["", "a\nb", "a\rb", "a b", "a\u{0}b", "é", String(repeating: "n", count: 513)] {
            #expect(throws: HostError.self) { _ = try keys.proof(host: host, nonce: nonce, binding: nil, deviceId: "phone", hostId: "h") }
        }
        #expect(throws: HostError.self) { _ = try keys.proof(host: "\(host)\nX", nonce: "n", binding: nil, deviceId: "phone", hostId: "h") }
        #expect(throws: HostError.self) { _ = try keys.proof(host: host, nonce: "n", binding: "c\r\n", deviceId: "phone", hostId: "h") }
        #expect(throws: HostError.self) { _ = try keys.proof(host: host, nonce: "n", binding: nil, deviceId: "phone\nx", hostId: "h") }
    }

    @Test func aMachinePairedBeforeItNamedAKeyHasNothingToSignWith() {
        let keys = standingKeys(SoftwareVault())
        #expect(throws: HostError.self) { _ = try keys.proof(host: host, nonce: "n", binding: nil, deviceId: "phone", hostId: "old") }
    }

    @Test func pairingAgainReplacesTheKeyAndRemovingTheMachineDeletesIt() throws {
        let vault = SoftwareVault()
        let keys = standingKeys(vault)
        let first = try #require(keys.make())
        try keys.keep(tag: first.tag, for: "h")
        let second = try #require(keys.make())
        try keys.keep(tag: second.tag, for: "h")
        #expect(vault.tags == [second.tag])
        let failed = try #require(keys.make())
        keys.discard(tag: failed.tag)
        #expect(vault.tags == [second.tag])
        try keys.forget(hostId: "h")
        #expect(vault.tags.isEmpty)
        #expect(throws: HostError.self) { _ = try keys.proof(host: host, nonce: "n", binding: nil, deviceId: "phone", hostId: "h") }
    }

    @Test func anOldKeyThatCantBeDeletedStaysNamedUntilItIs() throws {
        let vault = SoftwareVault()
        let keys = standingKeys(vault)
        let first = try #require(keys.make())
        try keys.keep(tag: first.tag, for: "h")
        let second = try #require(keys.make())
        vault.failDeletes = true
        // The earlier key can't go, so the new one isn't kept and the machine still names the old.
        #expect(throws: HostError.self) { try keys.keep(tag: second.tag, for: "h") }
        #expect(throws: HostError.self) { try keys.forget(hostId: "h") }
        let key = try publicKey(first)
        let proof = try keys.proof(host: host, nonce: "nonce-1", binding: nil, deviceId: "phone", hostId: "h")
        #expect(key.isValidSignature(try signature(proof), for: pairedText()))
        vault.failDeletes = false
        try keys.forget(hostId: "h")
        #expect(!vault.tags.contains(first.tag))
        #expect(throws: HostError.self) { _ = try keys.proof(host: host, nonce: "n", binding: nil, deviceId: "phone", hostId: "h") }
    }
}

@Suite struct PairedStandingProofTests {
    private func proving(_ vault: SoftwareVault, keyFor hostId: String? = "h") throws -> (PairedStandingProof, P256.Signing.PublicKey?) {
        let keys = standingKeys(vault)
        var key: P256.Signing.PublicKey?
        if let hostId {
            let made = try #require(keys.make())
            try keys.keep(tag: made.tag, for: hostId)
            key = try publicKey(made)
        }
        let proof = PairedStandingProof(signer: StandingSigner(hostId: "h", deviceId: "phone"), keys: keys, binding: nil, requestId: "standing-1")
        return (proof, key)
    }
    private func welcome(nonce: String? = "nonce-1") -> String {
        let challenge = nonce.map { #","standingNonce":"\#($0)","standingHost":"\#(host)""# } ?? ""
        return #"{"type":"welcome","protocolVersion":1,"hostId":"home"\#(challenge)}"#
    }

    @Test func theWelcomeOnThisSocketIsAnsweredWithAProofOfItsOwnChallenge() throws {
        let (proving, key) = try proving(SoftwareVault())
        guard case .send(let text) = proving.step(forWelcome: welcome()) else { Issue.record("no proof"); return }
        let message = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: String])
        #expect(message["type"] == "device.standing")
        #expect(message["requestId"] == "standing-1")
        let proof = try #require(message["proof"])
        #expect(try #require(key).isValidSignature(try signature(proof), for: pairedText()))
    }

    @Test func aDaemonThatAsksForNoProofIsSentNone() throws {
        let (proving, _) = try proving(SoftwareVault())
        #expect(proving.step(forWelcome: welcome(nonce: nil)) == .notAsked)
        #expect(proving.step(forWelcome: #"{"type":"pong"}"#) == .notAsked)
    }

    @Test func aPhoneWithoutAKeyOrAChallengeThatIsntCanonicalSaysStandingIsMissing() throws {
        #expect(try proving(SoftwareVault(), keyFor: nil).0.step(forWelcome: welcome()) == .missing)
        #expect(try proving(SoftwareVault()).0.step(forWelcome: welcome(nonce: #"a\nb"#)) == .missing)
    }

    @Test func onlyTheAnswerToThisSocketsProofIsTheVerdict() throws {
        let (proving, _) = try proving(SoftwareVault())
        let ok = #"{"type":"account.standing.result","requestId":"standing-1","result":{"ok":true,"until":9007199254740991}}"#
        let refused = #"{"type":"account.standing.result","requestId":"standing-1","result":{"ok":false,"code":"unauthorized","message":"No"}}"#
        let member = #"{"type":"account.standing.result","requestId":"standing-1","result":{"ok":true,"until":1,"member":{"org":"org_a"}}}"#
        let another = #"{"type":"account.standing.result","requestId":"script-2","result":{"ok":true,"until":1}}"#
        #expect(proving.verdict(ok) == .proven)
        #expect(proving.verdict(refused) == .missing)
        #expect(proving.verdict(member) == .missing)
        #expect(proving.verdict(another) == nil)
        #expect(proving.verdict(#"{"type":"pong"}"#) == nil)
    }

    @Test func onlyAPairedMachinesRuntimeProvesAndOnlyAsItsOwnDevice() throws {
        let target = ConnectionTarget(endpoint: try #require(URL(string: "wss://h:1/")), hostId: "h", deviceId: "phone",
                                      pin: DaemonCertificate.pin, secretKey: "mine")
        #expect(HostServices.connection(target).standingProof(binding: nil)?.signer == StandingSigner(hostId: "h", deviceId: "phone"))
        // The directory and pairing runtimes prove nothing.
        let directory = HostServices(secrets: MemorySecrets(), secretAccess: .directory)
        #expect(directory.standingProof(binding: nil) == nil)
    }
}
