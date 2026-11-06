import Foundation

/// One way a machine said it can be reached (`MachinePath` in `@ace/protocol`, ADR 0114): a
/// direct TLS listener pinned to its key (`loopback`, `lan`, `tailscale`), or a relay that pins
/// the machine's relay host key (`relay`, `account`). Learned only over an authenticated
/// connection to that machine, never from the network.
struct MachinePath: Codable, Sendable, Equatable {
    static let directKinds: Set<String> = ["loopback", "lan", "tailscale"]
    static let relayKinds: Set<String> = ["relay", "account"]
    let kind: String
    let url: String
    let fingerprint: String?
    let relayHostId: String?

    var isDirect: Bool { Self.directKinds.contains(kind) }

    init(kind: String, url: String, fingerprint: String? = nil, relayHostId: String? = nil) {
        self.kind = kind; self.url = url; self.fingerprint = fingerprint; self.relayHostId = relayHostId
    }
    /// Only a kind this build knows with the key it needs; anything else fails to decode and the
    /// list it is in skips it (`MachinePath.lenient`).
    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: Keys.self)
        kind = try box.decode(String.self, forKey: .kind)
        url = try box.decode(String.self, forKey: .url)
        fingerprint = try box.decodeIfPresent(String.self, forKey: .fingerprint)
        relayHostId = try box.decodeIfPresent(String.self, forKey: .relayHostId)
        let known = if Self.directKinds.contains(kind) { fingerprint.map(PinnedTrust.isPin) ?? false }
            else if Self.relayKinds.contains(kind) { relayHostId.map(NoiseFingerprint.isHostId) ?? false }
            else { false }
        guard known else { throw DecodingError.dataCorruptedError(forKey: .kind, in: box, debugDescription: "Unknown path") }
    }
    private enum Keys: String, CodingKey { case kind, url, fingerprint, relayHostId }

    /// The paths in `box[key]` this build reads; unknown or broken entries are skipped, and a
    /// missing or unreadable list is nil.
    static func lenient<Key: CodingKey>(_ box: KeyedDecodingContainer<Key>, forKey key: Key) -> [MachinePath]? {
        guard let list = try? box.decodeIfPresent([Lenient].self, forKey: key) else { return nil }
        return list.compactMap(\.path)
    }
    private struct Lenient: Decodable {
        let path: MachinePath?
        init(from decoder: any Decoder) throws { path = try? MachinePath(from: decoder) }
    }
}

extension MachineEntry {
    /// The relay host ids (Noise keys) this machine said a relay or ace's relay knows it by.
    var relayHostIds: Set<String> { Set((paths ?? []).compactMap(\.relayHostId)) }

    init(from decoder: any Decoder) throws {
        let box = try decoder.container(keyedBy: CodingKeys.self)
        self.init(hostId: try box.decode(String.self, forKey: .hostId), displayName: try box.decode(String.self, forKey: .displayName),
                  icon: try? box.decodeIfPresent(Icon.self, forKey: .icon), target: try box.decode(Target.self, forKey: .target),
                  deviceId: try box.decode(String.self, forKey: .deviceId),
                  paths: MachinePath.lenient(box, forKey: .paths),
                  accountHostId: try? box.decodeIfPresent(String.self, forKey: .accountHostId))
    }
}
