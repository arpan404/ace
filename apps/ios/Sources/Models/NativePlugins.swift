import Foundation

struct NativePlugin: Decodable, Identifiable {
    let name: String
    let version: String
    var id: String { name }
}
struct PluginPolicy: Decodable {
    let enabled: Bool
    let providers: [String]
    let name: String
}
struct PluginComponentRow: Decodable, Identifiable {
    struct Policy: Decodable { let enabled: Bool; let providers: [String] }
    let plugin: String
    let name: String
    let kind: String
    let title: String?
    let description: String
    let path: String
    let enabled: Bool
    let providers: [String]
    let skillAvailability: Policy?
    var id: String { "\(plugin)~\(kind)~\(name)" }
}
struct NativePluginReview: Decodable, Identifiable {
    let id: String
    let name: String
    let version: String
    let commit: String
    let hash: String
    let executionCount: Int?
    let unsupportedCount: Int?
}
struct PluginResponseRow: Decodable {
    let type: String
    let installs: [NativePlugin]?
    let availability: [PluginPolicy]?
    let components: [PluginComponentRow]?
    let nextOffset: Int?
    let reviews: [NativePluginReview]?
    let review: NativePluginReview?
    let entries: [ServiceValue]?
    let text: String?
    let hash: String?
    let bytes: Int?
    let offset: Int?
    let readonly: Bool?
}
private struct PluginEnvelope: Decodable { let response: PluginResponseRow }

extension ClientModel {
    func plugin(_ request: [String: Any], expecting: String) async throws -> PluginResponseRow {
        let reply = try await service(["type": "pluginRequest", "request": request], as: PluginEnvelope.self)
        guard reply.response.type == expecting else { throw ServiceFailure(message: "The plugin service returned a different response. Refresh and try again.") }
        return reply.response
    }
    /// A plugin list the bridge keeps (`bridge/read-policy.ts`), read like `plugin`.
    func pluginRead(_ request: [String: Any], expecting: String) async throws -> PluginResponseRow {
        let reply = try await read(["type": "pluginRequest", "request": request], as: PluginEnvelope.self)
        guard reply.response.type == expecting else { throw ServiceFailure(message: "The plugin service returned a different response. Refresh and try again.") }
        return reply.response
    }
    /// The last kept answer to a plugin list, for drawing before it is read again.
    func keptPlugin(_ request: [String: Any], expecting: String) -> PluginResponseRow? {
        kept(["type": "pluginRequest", "request": request], as: PluginEnvelope.self).map(\.response).flatMap { $0.type == expecting ? $0 : nil }
    }
    /// Moves when a kept plugin list goes out of date.
    func pluginGeneration(_ request: [String: Any]) -> Int { readGeneration(["type": "pluginRequest", "request": request]) }
}

struct PluginReviewRequest: Identifiable {
    let id = UUID()
    let operation: [String: Any]
}

/// Review entries are shown in full, including execution arguments, environment and diagnostics.
func pluginReviewText(_ value: ServiceValue) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return (try? encoder.encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? ""
}
