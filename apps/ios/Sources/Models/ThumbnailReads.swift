import UIKit

/// Preview reads in flight, at most one per key. A tile that leaves the screen mid-read (a fling
/// recycles its cell) stops waiting, never the read: the preview still lands wherever `start`
/// keeps it, and a tile showing it again joins the read under way or finds it kept, instead of
/// asking the host from scratch. Holds only the reads running now.
@MainActor final class ThumbnailReads {
    private var running: [String: Task<UIImage?, Never>] = [:]

    /// Reads under way.
    var count: Int { running.count }

    /// `kept()` when it has the preview; otherwise the read already running for `key`, or a new
    /// one from `start`, which runs to its end whatever happens to the caller.
    func read(_ key: String, kept: () -> UIImage?, start: @escaping @MainActor () async -> UIImage?) async -> UIImage? {
        if let hit = kept() { return hit }
        if let task = running[key] { return await task.value }
        let task = Task { @MainActor [weak self] in
            let image = await start()
            self?.running[key] = nil
            return image
        }
        running[key] = task
        return await task.value
    }
}
