import Foundation

/// Atomic, protected local drafts. A command must persist its identity before dispatch.
struct DraftFile<Value: Codable & Sendable>: Sendable {
    let url: URL
    func load() -> Value? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Value.self, from: data)
    }
    func save(_ value: Value) throws {
        let data = try JSONEncoder().encode(value)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
