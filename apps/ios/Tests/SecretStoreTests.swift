import Foundation
import Testing
@testable import Ace

@Suite struct SecretStoreTests {
    private let token = String(repeating: "c", count: 64)

    @Test func keychainTokensRoundTripReplaceAndDelete() throws {
        let store = KeychainSecrets(service: "app.ace.ios.tests.\(UUID().uuidString)")
        let key = "[\"host\",\"device\"]"
        defer { try? store.delete(key) }
        #expect(try store.get(key) == nil)
        try store.set(key, token)
        #expect(try store.get(key) == token)
        let rotated = String(repeating: "d", count: 64)
        try store.set(key, rotated)
        #expect(try store.get(key) == rotated)
        #expect(try KeychainSecrets(service: store.service + ".other").get(key) == nil)
        try store.delete(key)
        #expect(try store.get(key) == nil)
        try store.delete(key)
    }
    @Test func aMachineConnectionReadsOnlyItsOwnTokenAndCannotWrite() throws {
        let store = MemorySecrets()
        try store.set("mine", token)
        try store.set("other", String(repeating: "e", count: 64))
        let target = ConnectionTarget(endpoint: try #require(URL(string: "wss://h:1/")), hostId: "h", deviceId: "d", pin: DaemonCertificate.pin, secretKey: "mine")
        var services = HostServices.connection(target)
        services.secrets = store
        #expect(try services.perform("secret.get", input: JSONEncoder().encode("mine")) == token)
        #expect(throws: HostError.self) { _ = try services.perform("secret.get", input: JSONEncoder().encode("other")) }
        #expect(throws: HostError.self) { _ = try services.perform("secret.delete", input: JSONEncoder().encode("mine")) }
        #expect(throws: HostError.self) { _ = try services.perform("secret.set", input: Data("{\"key\":\"mine\",\"token\":\"\(token)\"}".utf8)) }
        #expect(throws: HostError.self) { _ = try services.perform("directory.load", input: Data("null".utf8)) }
        #expect(try store.get("mine") == token)
    }
    @Test func theDirectoryRuntimeStoresOnlyWellFormedDeviceTokens() throws {
        let store = MemorySecrets()
        let services = HostServices(secrets: store, secretAccess: .directory)
        _ = try services.perform("secret.set", input: Data("{\"key\":\"k\",\"token\":\"\(token)\"}".utf8))
        #expect(try store.get("k") == token)
        #expect(throws: HostError.self) { _ = try services.perform("secret.set", input: Data("{\"key\":\"k\",\"token\":\"code-or-ticket\"}".utf8)) }
        #expect(try store.get("k") == token)
    }
}

final class MemorySecrets: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    func get(_ key: String) throws -> String? { lock.withLock { values[key] } }
    func set(_ key: String, _ value: String) throws { lock.withLock { values[key] = value } }
    func delete(_ key: String) throws { _ = lock.withLock { values.removeValue(forKey: key) } }
}
