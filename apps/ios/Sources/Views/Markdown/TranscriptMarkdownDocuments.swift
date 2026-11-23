import Foundation
import Markit
import Synchronization

/// Parsed answers belong to the open thread. Prefetch and visible rows share one parser so
/// a burst of page patches cannot start a parser for each row at once.
actor TranscriptMarkdownDocuments {
    private struct Entry {
        let document: MarkitDocument
        let bytes: Int
    }

    private struct Cache {
        var entries: [String: Entry] = [:]
        var order: [String] = []
        var bytes = 0

        mutating func insert(_ entry: Entry, for key: String) {
            let limit = 4 * 1024 * 1024
            guard entry.bytes <= limit else { return }
            while bytes + entry.bytes > limit || order.count >= 64 {
                if let removed = entries.removeValue(forKey: order.removeFirst()) { bytes -= removed.bytes }
            }
            entries[key] = entry
            order.append(key)
            bytes += entry.bytes
        }
    }

    private let cache = Mutex(Cache())

    nonisolated static func key(_ text: String, flavor: MarkitFlavor) -> String {
        "\(flavor.rawValue):" + contentKey(text)
    }

    nonisolated func cached(_ key: String) -> MarkitDocument? {
        cache.withLock { $0.entries[key]?.document }
    }

    func document(_ text: String, flavor: MarkitFlavor, key: String) -> MarkitDocument? {
        if let kept = cached(key) { return kept }
        guard !Task.isCancelled else { return nil }
        let parsed = try? HostTrace.measure("markdown.parse") { try Markit.parse(text, flavor: flavor) }
        guard let parsed else { return nil }
        let bytes = text.utf8.count + parsed.text.utf8.count + parsed.blocks.count * MemoryLayout<MarkitBlock>.stride
            + parsed.spans.reduce(0) { $0 + MemoryLayout<MarkitSpan>.stride + ($1.png?.utf8.count ?? 0) }
        cache.withLock { $0.insert(Entry(document: parsed, bytes: bytes), for: key) }
        return parsed
    }
}

/// At most one batch reads ahead. A newer batch replaces work the reader is moving away from.
@MainActor final class TranscriptMarkdownPrefetch {
    let documents = TranscriptMarkdownDocuments()
    private var pending: Task<Void, Never>?

    deinit { pending?.cancel() }

    func prepare(_ sources: [String]) {
        guard !sources.isEmpty else { return }
        pending?.cancel()
        let documents = documents
        pending = Task.detached(priority: .utility) {
            for source in sources {
                guard !Task.isCancelled else { break }
                for case .prose(let text) in MarkdownBlocks.split(source) {
                    let key = TranscriptMarkdownDocuments.key(text, flavor: .agent)
                    _ = await documents.document(text, flavor: .agent, key: key)
                }
            }
        }
    }
}
