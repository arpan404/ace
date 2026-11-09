import Foundation

/// The handoff queue and the catalogue in the app group the app, the share extension and the
/// intents share: one JSON file per handoff (written atomically, protected until first unlock)
/// with its files in a folder beside it, and one catalogue file. A handoff leaves the queue only
/// when the app has saved its start (`remove`).
struct HandoffStore: Sendable {
    static let appGroup = "group.app.ace.ios"
    let root: URL

    /// The app group's folder; nil where the group isn't granted (an unsigned build), and then
    /// nothing can be handed over.
    static func shared() -> HandoffStore? {
        guard let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        return HandoffStore(root: base.appendingPathComponent("handoff", isDirectory: true))
    }

    private var queue: URL { root.appendingPathComponent("queue", isDirectory: true) }
    private var catalogueURL: URL { root.appendingPathComponent("catalogue.json") }
    private func entry(_ id: String) -> URL { queue.appendingPathComponent(id + ".json") }
    func folder(_ id: String) -> URL { queue.appendingPathComponent(id, isDirectory: true) }
    func file(_ handoff: Handoff, _ file: HandoffFile) -> URL { folder(handoff.id).appendingPathComponent(file.stored) }

    /// Queues `handoff`, copying `files` (data and how to name it) beside it first, so a queued
    /// handoff never names a file that isn't there.
    func add(_ handoff: Handoff, files: [(data: Data, name: String, mimeType: String)] = []) throws {
        guard Self.valid(handoff.id) else { throw CocoaError(.fileWriteInvalidFileName) }
        var kept = handoff
        if !files.isEmpty {
            try FileManager.default.createDirectory(at: folder(handoff.id), withIntermediateDirectories: true)
            kept.files = try files.enumerated().map { index, file in
                let stored = "\(index)-" + Self.safeName(file.name)
                try file.data.write(to: folder(handoff.id).appendingPathComponent(stored),
                                    options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                return HandoffFile(stored: stored, name: file.name, mimeType: file.mimeType)
            }
        }
        try write(kept, to: entry(handoff.id))
    }
    /// Every queued handoff, oldest first. One that can't be read is skipped, never fatal.
    func pending() -> [Handoff] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: queue.path)) ?? []
        return names.filter { $0.hasSuffix(".json") }
            .compactMap { name in (try? Data(contentsOf: queue.appendingPathComponent(name))).flatMap { try? Self.decoder.decode(Handoff.self, from: $0) } }
            .sorted { $0.created < $1.created }
    }
    func handoff(_ id: String) -> Handoff? {
        guard Self.valid(id), let data = try? Data(contentsOf: entry(id)) else { return nil }
        return try? Self.decoder.decode(Handoff.self, from: data)
    }
    /// The start is saved: the handoff and its files go.
    func remove(_ id: String) {
        guard Self.valid(id) else { return }
        try? FileManager.default.removeItem(at: entry(id))
        try? FileManager.default.removeItem(at: folder(id))
    }

    func catalogue() -> HandoffCatalogue {
        (try? Data(contentsOf: catalogueURL)).flatMap { try? Self.decoder.decode(HandoffCatalogue.self, from: $0) } ?? HandoffCatalogue()
    }
    func save(_ catalogue: HandoffCatalogue) {
        guard catalogue != self.catalogue() else { return }
        try? write(catalogue, to: catalogueURL)
    }

    private func write<Value: Encodable>(_ value: Value, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try encoder.encode(value).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return decoder
    }
    private static func valid(_ id: String) -> Bool { UUID(uuidString: id) != nil }
    /// A shared file's name as a path component: no separators, never empty, bounded.
    static func safeName(_ name: String) -> String {
        let cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let bounded = String(cleaned.prefix(120))
        return bounded.isEmpty || bounded.hasPrefix(".") ? "file" + bounded : bounded
    }
}
