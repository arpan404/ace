import Foundation

/// This app install's own identity (ADR 0115): one UUIDv7, made on first run and kept for good.
/// It names the phone to every machine on every path (a pairing's device, the ace account's
/// device grant), so signing out and in, switching accounts or networks, or pairing again never
/// makes this phone a second device.
///
/// Kept in the Keychain, which outlives a reinstall, and mirrored in UserDefaults. A build from
/// before install ids kept an account device id per account origin (`ace.account.device.<origin>`);
/// the first one found is adopted, so machine-code passes keyed by it keep holding.
struct InstallIdentity {
    static let key = "ace.install.id"
    static let legacyPrefix = "ace.account.device."
    let keychain: any SecretStore
    let defaults: UserDefaults
    /// Unix time in milliseconds.
    let now: @Sendable () -> Double
    /// At least 10 random bytes.
    let random: @Sendable () -> [UInt8]

    /// The Keychain, standard defaults, the wall clock and the system's random bytes.
    static var system: InstallIdentity {
        InstallIdentity(keychain: KeychainSecrets(service: "app.ace.ios.install"), defaults: .standard,
                        now: { Date().timeIntervalSince1970 * 1000 },
                        random: { var generator = SystemRandomNumberGenerator(); return (0..<10).map { _ in generator.next() } })
    }

    /// The install id: the kept one, else the adopted legacy one, else a new UUIDv7. Whatever is
    /// missing from the Keychain or the mirror is written back.
    func id() -> String {
        let inKeychain = ((try? keychain.get(Self.key)) ?? nil).flatMap(Self.valid)
        let mirrored = defaults.string(forKey: Self.key).flatMap(Self.valid)
        let id = inKeychain ?? mirrored ?? legacy() ?? Self.uuidV7(ms: now(), random: random())
        if inKeychain != id { try? keychain.set(Self.key, id) }
        if mirrored != id { defaults.set(id, forKey: Self.key) }
        return id
    }

    /// The first legacy account device id, in key order so every launch picks the same one.
    private func legacy() -> String? {
        defaults.dictionaryRepresentation().keys.filter { $0.hasPrefix(Self.legacyPrefix) }.sorted()
            .lazy.compactMap { defaults.string(forKey: $0).flatMap(Self.valid) }.first
    }

    /// `InstallId` in `@ace/protocol`: 8 to 64 letters, digits and hyphens.
    static func valid(_ value: String) -> String? {
        (8...64).contains(value.utf8.count) && value.utf8.allSatisfy { byte in
            (0x30...0x39).contains(byte) || (0x41...0x5a).contains(byte) || (0x61...0x7a).contains(byte) || byte == 0x2d
        } ? value : nil
    }

    /// A UUIDv7 (RFC 9562 §5.7) from a Unix millisecond time and 10 random bytes, written as the
    /// shared client's `uuidV7` writes it: lowercase, hyphenated.
    static func uuidV7(ms: Double, random: [UInt8]) -> String {
        precondition(random.count >= 10, "UUIDv7 needs 10 random bytes")
        let time = UInt64(max(0, min(ms, Double(1 << 48 - 1))))
        var bytes = [UInt8](repeating: 0, count: 16)
        for index in 0..<6 { bytes[index] = UInt8(truncatingIfNeeded: time >> (8 * UInt64(5 - index))) }
        for index in 0..<10 { bytes[6 + index] = random[index] }
        bytes[6] = 0x70 | (bytes[6] & 0x0f)
        bytes[8] = 0x80 | (bytes[8] & 0x3f)
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        let cut = [8, 4, 4, 4, 12]
        var parts: [String] = [], rest = Substring(hex)
        for length in cut { parts.append(String(rest.prefix(length))); rest = rest.dropFirst(length) }
        return parts.joined(separator: "-")
    }
}
