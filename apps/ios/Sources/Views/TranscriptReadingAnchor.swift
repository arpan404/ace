import SwiftUI

/// Geometry belongs to the viewport, so keeping it never invalidates the observed message rows.
@MainActor final class TranscriptReadingAnchor {
    var frames: [String: CGRect] = [:]
    private var pinned: (id: String, point: UnitPoint)?

    func capture(viewport: CGFloat, topInset: CGFloat, bottomInset: CGFloat) {
        pinned = nil
        guard let first = frames.filter({ $0.value.maxY > topInset && $0.value.minY < viewport - bottomInset })
            .min(by: { $0.value.minY < $1.value.minY }) else { return }
        let available = viewport - topInset - bottomInset - first.value.height
        guard abs(available) > 1 else { return }
        // scrollTo aligns the same fraction of the row and viewport. Choosing that fraction
        // from the old geometry retains partial rows as well as rows aligned to the top.
        pinned = (first.key, UnitPoint(x: 0, y: (first.value.minY - topInset) / available))
    }
    func restore(with proxy: ScrollViewProxy) {
        guard let pinned else { return }
        proxy.scrollTo(pinned.id, anchor: pinned.point)
    }
}
