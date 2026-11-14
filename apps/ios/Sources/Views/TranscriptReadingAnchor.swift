import SwiftUI

/// Geometry observed by the I/O shell. The viewport controller owns the semantic
/// anchor and computes alignment from the row's current size when restoring it.
///
/// A class the feed's body never reads, so writing it from a geometry action never re-lays out
/// the rows.
@MainActor final class TranscriptReadingAnchor {
    /// Where the shown rows sit; on screen once offset by the content's origin.
    var rows = TranscriptRowFrames()
    /// A drift correction scrolled the feed: check the held row again once the scroll lands.
    var recheckDrift = false
    /// When to take the top row as the one to hold (after a drag, after a turn-key jump).
    var captures = TranscriptCaptureSchedule()
    /// Each row's last measured height, kept while it is off screen, so a row that comes back at
    /// another height (a page loading in again, a placeholder) is counted. Measurement only.
    private var heights: [String: CGFloat] = [:]

    /// Records `height` for `id`, counting a change of height in the performance probe:
    /// `rows.resized` for any change, `rows.resizedOnReturn` for a row coming back on screen at
    /// another height than it left with (the jump a reader sees scrolling back).
    func measured(_ id: String, height: CGFloat, returning: Bool) {
        guard PerfProbe.enabled else { return }
        if let last = heights[id], abs(last - height) > 1 {
            PerfProbe.add("rows.resized", 1)
            if returning { PerfProbe.add("rows.resizedOnReturn", 1) }
        }
        heights[id] = height
    }
    /// The layout changed (width, type size, density, a disclosure): earlier heights don't count.
    func layoutChanged() { heights.removeAll() }
}
