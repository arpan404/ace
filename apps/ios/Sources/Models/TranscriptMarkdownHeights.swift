import Foundation
import Synchronization

/// A small, replaceable disk cache of finished Markdown measurements. Keys carry the content
/// hash and layout inputs. A row can read them synchronously after the cache is warmed.
actor TranscriptMarkdownHeightDisk {
    struct Measurement: Codable, Sendable {
        let key: String
        let height: Double

        var valid: Bool { key.utf8.count <= 160 && height.isFinite && height > 0 && height <= 1_000_000 }
    }

    nonisolated let url: URL
    private let visible = Mutex([String: Double]())
    private var values: [String: Double] = [:]
    private var order: [String] = []
    private var loaded = false
    private static let capacity = 768
    private static let maxReadBytes = 160 * 1024

    init(url: URL) { self.url = url }

    nonisolated func height(for key: String) -> Double? {
        visible.withLock { $0[key] }
    }

    func load() {
        guard !loaded else { return }
        loaded = true
        guard let file = try? FileHandle(forReadingFrom: url) else { return }
        defer { try? file.close() }
        guard let data = try? file.read(upToCount: Self.maxReadBytes + 1),
              data.count <= Self.maxReadBytes,
              let measurements = try? JSONDecoder().decode([Measurement].self, from: data) else { return }
        _ = apply(measurements.suffix(Self.capacity))
    }

    func save(_ measurements: [Measurement]) {
        load()
        let rows = apply(measurements[...])
        guard let data = try? JSONEncoder().encode(rows), data.count <= Self.maxReadBytes else { return }
        try? data.write(to: url, options: .atomic)
    }

    func clear() {
        loaded = true
        order.removeAll()
        values.removeAll()
        visible.withLock { $0 = [:] }
        try? FileManager.default.removeItem(at: url)
    }

    private func apply(_ measurements: ArraySlice<Measurement>) -> [Measurement] {
        for entry in measurements where entry.valid {
            if values.updateValue(entry.height, forKey: entry.key) != nil {
                order.removeAll { $0 == entry.key }
            }
            order.append(entry.key)
        }
        if order.count > Self.capacity {
            let excess = order.count - Self.capacity
            for key in order.prefix(excess) { values[key] = nil }
            order.removeFirst(excess)
        }
        visible.withLock { $0 = values }
        return order.compactMap { key in values[key].map { Measurement(key: key, height: $0) } }
    }
}

/// Coalesces height writes above the lifetime of any one thread. The visible thread also keeps
/// its most recent measurements in its view shelf, so writes never gate layout.
@MainActor final class TranscriptMarkdownHeights {
    let disk: TranscriptMarkdownHeightDisk
    private var pending: [String: Double] = [:]
    private var scheduled: Task<Void, Never>?
    private var writing: Task<Void, Never>?

    init(url: URL) {
        disk = TranscriptMarkdownHeightDisk(url: url)
        Task { await disk.load() }
    }

    func remember(_ key: String, height: Double) {
        guard (pending[key] ?? disk.height(for: key)) != height else { return }
        pending[key] = height
        if pending.count >= 128 { flush(); return }
        guard scheduled == nil else { return }
        scheduled = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            self?.flush()
        }
    }

    func clear() {
        scheduled?.cancel()
        scheduled = nil
        pending.removeAll()
        enqueue { [disk] in await disk.clear() }
    }

    private func flush() {
        scheduled?.cancel()
        scheduled = nil
        let entries = pending.map { TranscriptMarkdownHeightDisk.Measurement(key: $0.key, height: $0.value) }
        pending.removeAll(keepingCapacity: true)
        enqueue { [disk] in await disk.save(entries) }
    }

    private func enqueue(_ write: @escaping @Sendable () async -> Void) {
        let preceding = writing
        writing = Task {
            await preceding?.value
            await write()
        }
    }
}
