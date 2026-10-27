import Foundation

/// One machine's links, paired devices and open pairing links, in the words the bridge chose
/// (`bridge/fleet-admin.ts`).
struct FleetOverview: Decodable, Sendable {
    struct Choice: Decodable, Sendable, Identifiable, Hashable { let id: String; let label: String; let note: String }
    struct Lifetime: Decodable, Sendable, Identifiable, Hashable { let value: Int; let label: String; var id: Int { value } }
    struct Choices: Decodable, Sendable { let access: [Choice]; let extras: [Choice]; let linkLifetimes: [Lifetime]; let deviceLifetimes: [Lifetime] }
    struct Link: Decodable, Sendable, Identifiable { let hostId: String?; let name: String; let profile: String; let status: String; let deviceId: String; let line: String; var id: String { profile } }
    struct Device: Decodable, Sendable, Identifiable { let id: String; let name: String; let `self`: Bool; let access: String; let lastSeenAt: Double; let expiresAt: Double? }
    struct Pairing: Decodable, Sendable, Identifiable { let id: String; let label: String; let line: String; let expiresAt: Double }
    let choices: Choices
    let forbidden: Bool
    let links: [Link]
    let linksProblem: String?
    let devices: [Device]
    let devicesProblem: String?
    let pairings: [Pairing]
    let pairingsProblem: String?
}

/// A fleet write's answer: ok, or the refusal in words.
struct FleetAnswer: Decodable, Sendable {
    let ok: Bool
    var code: String? = nil
    var message: String? = nil
    var id: String? = nil
    var url: String? = nil
    /// A pairing's code, for typing in by hand.
    var codeText: String? = nil
    var expiresAt: Double? = nil
    var count: Int? = nil
    private enum Keys: String, CodingKey { case ok, code, message, id, url, expiresAt, count }
    init(ok: Bool, message: String? = nil) { self.ok = ok; self.message = message }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: Keys.self)
        ok = try values.decode(Bool.self, forKey: .ok)
        message = try values.decodeIfPresent(String.self, forKey: .message)
        id = try values.decodeIfPresent(String.self, forKey: .id)
        url = try values.decodeIfPresent(String.self, forKey: .url)
        expiresAt = try values.decodeIfPresent(Double.self, forKey: .expiresAt)
        count = try values.decodeIfPresent(Int.self, forKey: .count)
        // A refusal's `code` is its reason; a pairing's is what a person types.
        let code = try values.decodeIfPresent(String.self, forKey: .code)
        if ok { codeText = code } else { self.code = code }
    }
}

extension ClientModel {
    func fleetOverview(machine: String) async throws -> FleetOverview {
        try await service(["type": "native.fleet", "machine": machine, "request": ["op": "overview"]], as: FleetOverview.self)
    }
    func fleet(_ request: [String: Any], machine: String) async -> FleetAnswer {
        do { return try await service(["type": "native.fleet", "machine": machine, "request": request], as: FleetAnswer.self) }
        catch { return FleetAnswer(ok: false, message: error.localizedDescription) }
    }
}
