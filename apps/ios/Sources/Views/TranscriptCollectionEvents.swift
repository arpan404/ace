import SwiftUI

/// One entry of the transcript: a row, the tail, a spacer. `key` changes when what it shows
/// changes; an entry whose key holds is never configured again, so a fling re-evaluates only
/// the rows coming on screen.
struct TranscriptEntry {
    let id: String
    let key: AnyHashable
    /// A transcript row: the feed hears where it lays out, and when it comes and goes.
    var isRow = false
    let content: () -> AnyView
}

/// The scroll view's geometry in its own (physical) coordinates.
struct TranscriptScrollGeometry: Equatable, Sendable {
    var offset: CGFloat = 0
    var contentHeight: CGFloat = 0
    var viewport: CGFloat = 0
}

/// What the feed hears from the collection. Set on each update, so the closures see the feed's
/// latest values.
struct TranscriptCollectionEvents {
    var phase: (_ old: TranscriptScrollPhase, _ new: TranscriptScrollPhase, _ geometry: TranscriptScrollGeometry,
                _ releaseVelocity: Double?) -> Void = { _, _, _, _ in }
    var geometry: (_ old: TranscriptScrollGeometry, _ new: TranscriptScrollGeometry) -> Void = { _, _ in }
    /// Rows the layout placed again, with the scroll geometry as it left it, when that changed
    /// too: a resize it corrected the offset for, a window change. One change, so the feed never
    /// sees a row moved against the offset from before.
    var rowsLaidOut: (_ rows: [(id: String, frame: CGRect)], _ geometry: (old: TranscriptScrollGeometry,
                                                                           new: TranscriptScrollGeometry)?) -> Void
        = { _, _ in }
    var rowAppeared: (_ id: String) -> Void = { _ in }
    var rowGone: (_ id: String) -> Void = { _ in }
    /// An assistive swipe pages toward older rows or newer, moving the feed or not (at the
    /// loaded edge). True when more rows were asked for.
    var assistivePage: (_ older: Bool, _ moves: Bool) -> Bool = { _, _ in false }
    /// A window change moved the offset to keep the reader's entry on screen.
    var placeKept: (_ by: CGFloat) -> Void = { _ in }
}
