import CryptoKit
import Foundation
import Testing
@testable import Ace

/// A software P-256 vault standing in for the Secure Enclave.
final class SoftwareVault: StandingKeyVault, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: P256.Signing.PrivateKey] = [:]
    var tags: [String] { lock.withLock { keys.keys.sorted() } }
    func create(tag: String) throws -> Data {
        let key = P256.Signing.PrivateKey()
        lock.withLock { keys[tag] = key }
        return key.publicKey.x963Representation
    }
    func sign(tag: String, message: Data) throws -> Data {
        guard let key = lock.withLock({ keys[tag] }) else { throw HostError.unsupported }
        return try key.signature(for: message).derRepresentation
    }
    func delete(tag: String) { _ = lock.withLock { keys.removeValue(forKey: tag) } }
    func publicKey(_ tag: String) -> P256.Signing.PublicKey? { lock.withLock { keys[tag]?.publicKey } }
}

@Suite struct StandingKeysTests {
    private func keys(_ vault: SoftwareVault) -> StandingKeys {
        let counter = Counter()
        return StandingKeys(vault: vault, names: MemorySecrets(), newTag: { "tag-\(counter.next())" })
    }
    private func text(device: String = "phone", nonce: String = "nonce-1") -> String {
        "ace-paired-standing/v1\n\(String(repeating: "H", count: 52))\n\(nonce)\nnone\n\(device)"
    }
    private func decode(_ base64url: String) -> Data? {
        var text = base64url.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while text.count % 4 != 0 { text += "=" }
        return Data(base64Encoded: text)
    }

    @Test func aPairedMachineSignsItsOwnDevicesProofWithTheKeyItNamed() throws {
        let vault = SoftwareVault()
        let standing = keys(vault)
        let made = try #require(standing.make())
        #expect(made.publicKey.count == 87)
        try standing.keep(tag: made.tag, for: "host-studio")
        let proof = try standing.sign(text(), hostId: "host-studio", deviceId: "phone")
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: try #require(decode(proof)))
        let publicKey = try P256.Signing.PublicKey(x963Representation: try #require(decode(made.publicKey)))
        #expect(publicKey.isValidSignature(signature, for: Data(text().utf8)))
        // Made for this socket's nonce: it says nothing about another one.
        #expect(!publicKey.isValidSignature(signature, for: Data(text(nonce: "nonce-2").utf8)))
    }

    @Test func theKeySignsNothingButThisDevicesPairedProof() throws {
        let standing = keys(SoftwareVault())
        let made = try #require(standing.make())
        try standing.keep(tag: made.tag, for: "host-studio")
        for refused in [text(device: "another-device"), "ace-standing/v2\nH\nn\nnone\ngrant", "anything at all",
                        text() + "\nextra", "ace-paired-standing/v1\n\nnonce\nnone\nphone"] {
            #expect(throws: HostError.self) { _ = try standing.sign(refused, hostId: "host-studio", deviceId: "phone") }
        }
    }

    @Test func aMachinePairedBeforeItNamedAKeyHasNothingToSignWith() {
        let standing = keys(SoftwareVault())
        #expect(throws: HostError.self) { _ = try standing.sign(text(), hostId: "host-old", deviceId: "phone") }
    }

    @Test func pairingAgainReplacesTheKeyAndRemovingTheMachineDeletesIt() throws {
        let vault = SoftwareVault()
        let standing = keys(vault)
        let first = try #require(standing.make())
        try standing.keep(tag: first.tag, for: "host-studio")
        let second = try #require(standing.make())
        try standing.keep(tag: second.tag, for: "host-studio")
        #expect(vault.tags == [second.tag])
        let failed = try #require(standing.make())
        standing.discard(tag: failed.tag)
        #expect(vault.tags == [second.tag])
        standing.forget(hostId: "host-studio")
        #expect(vault.tags.isEmpty)
        #expect(throws: HostError.self) { _ = try standing.sign(text(), hostId: "host-studio", deviceId: "phone") }
    }

    @Test func onlyAPairedMachinesRuntimeMaySignAndOnlyForItself() throws {
        let vault = SoftwareVault()
        let standing = keys(vault)
        let made = try #require(standing.make())
        try standing.keep(tag: made.tag, for: "h")
        let target = ConnectionTarget(endpoint: try #require(URL(string: "wss://h:1/")), hostId: "h", deviceId: "phone",
                                      pin: DaemonCertificate.pin, secretKey: "mine")
        var services = HostServices.connection(target)
        services.standingKeys = standing
        #expect(try services.perform("standing.sign", body: text())?.count == 86)
        #expect(throws: HostError.self) { _ = try services.perform("standing.sign", body: text(device: "other")) }
        // The directory and pairing runtimes sign nothing.
        var directory = HostServices(secrets: MemorySecrets(), secretAccess: .directory)
        directory.standingKeys = standing
        #expect(throws: HostError.self) { _ = try directory.perform("standing.sign", body: text()) }
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func next() -> Int { lock.withLock { value += 1; return value } }
}
