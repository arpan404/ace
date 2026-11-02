import CryptoKit
import Foundation

/// The SHA-256 of `text`, hex: what identifies drawn content across row appearances.
nonisolated func contentKey(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
}

/// What one thread keeps of the rows it has drawn, so a row scrolled back into view comes back at
/// once at the height it had: each one's last measured height, and the last few built views off
/// screen (loaded pages, rendered Markdown), ready to put back without building them again. A
/// view on screen is never on the shelf. Keys are content hashes (`contentKey`). Generic over the
/// view so its keeping and eviction can be tested without UIKit.
@MainActor final class ViewShelf<Kept: AnyObject> {
    private var heights: [String: CGFloat] = [:]
    private var heightOrder: [String] = []
    private var kept: [(id: String, view: Kept)] = []
    let maxHeights: Int
    let maxKept: Int

    init(maxHeights: Int = 256, maxKept: Int = 6) {
        self.maxHeights = maxHeights
        self.maxKept = maxKept
    }

    /// The height `id` last measured, if it has been drawn.
    func height(_ id: String) -> CGFloat? { heights[id] }

    func remember(height: CGFloat, for id: String) {
        if heights.updateValue(height, forKey: id) == nil { heightOrder.append(id) }
        while heightOrder.count > maxHeights { heights[heightOrder.removeFirst()] = nil }
    }

    /// Takes `id`'s built view off the shelf, for a row coming on screen.
    func take(_ id: String) -> Kept? {
        guard let index = kept.firstIndex(where: { $0.id == id }) else { return nil }
        return kept.remove(at: index).view
    }

    /// Puts a view that went off screen on the shelf; past the limit the longest kept goes.
    func put(_ view: Kept, for id: String) {
        kept.removeAll { $0.id == id }
        kept.append((id, view))
        if kept.count > maxKept { kept.removeFirst(kept.count - maxKept) }
    }

    var keptCount: Int { kept.count }
}
