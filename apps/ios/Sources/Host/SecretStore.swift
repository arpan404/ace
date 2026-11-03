import Foundation
import Security

/// Revocable ace and device tokens. Pairing codes, tickets and tokens never enter SQLite, files or logs.
protocol SecretStore: Sendable {
    func get(_ key: String) throws -> String?
    func set(_ key: String, _ value: String) throws
    func delete(_ key: String) throws
}

/// iOS Keychain generic passwords: this device only, available after first unlock so the SDK
/// can reconnect in the background. Never synchronized or restored to another phone.
struct KeychainSecrets: SecretStore {
    let service: String
    init(service: String = "app.ace.ios.device-token") { self.service = service }

    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: key, kSecAttrSynchronizable as String: false]
    }
    func get(_ key: String) throws -> String? {
        var query = query(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            throw HostError.storage
        }
        return value
    }
    func set(_ key: String, _ value: String) throws {
        let data = Data(value.utf8)
        let update = SecItemUpdate(query(key) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw HostError.storage }
        var item = query(key)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw HostError.storage }
    }
    func delete(_ key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw HostError.storage }
    }
}

/// What a runtime may do with secrets. A machine's connection can read only its own token.
enum SecretAccess: Sendable {
    case none
    case read(String)
    case directory

    func permits(_ operation: String, key: String) -> Bool {
        switch self {
        case .none: false
        case .read(let own): operation == "secret.get" && key == own
        case .directory: key.utf8.count <= 1024
        }
    }
}
