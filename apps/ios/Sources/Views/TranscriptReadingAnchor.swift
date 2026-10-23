import SwiftUI

/// Geometry belongs to the viewport, so keeping it never invalidates the observed message rows.
///
/// Rows report their frames in the feed's content, which scrolling leaves alone; the scroll offset
/// turns them into places on screen only when a page of history replaces the window. A frame in
/// the viewport changes on every scrolled frame, for every row the lazy stack keeps, prefetched
/// rows too: with an accessibility client attached that kept the stack re-placing its rows and
/// pinned the main thread.
@MainActor final class TranscriptReadingAnchor {
    static let space = "transcript.content"
    var frames: [String: CGRect] = [:]
    private var pinned: (id: String, point: UnitPoint)?

    /// `offset` is the scroll view's content offset, the same as `ScrollGeometry.contentOffset.y`.
    func capture(offset: CGFloat, viewport: CGFloat, topInset: CGFloat, bottomInset: CGFloat) {
        pinned = nil
        let frames = frames.mapValues { $0.offsetBy(dx: 0, dy: -offset) }
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
