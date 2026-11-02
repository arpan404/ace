import Foundation

/// When the feed tells the bridge the reader left the live end (hold the rows they read) or
/// returned to it (follow it again). Pure: scroll facts in, one read out.
///
/// The reader turning near the end, a fling bouncing off it, must not send a read each time:
/// every hold or follow is a bridge round trip and moves the reading state the feed draws from.
/// A hold goes once the reader is a screen away mid-gesture, or comes to rest away from the
/// end; a follow only once they come to rest at it. Within a screen of the end, the tail trims
/// only rows far above the reader, so holding later loses nothing they see.
enum TranscriptEndRead: Equatable, Sendable {
    case hold
    case follow
    case none

    struct Facts: Equatable, Sendable {
        /// How far the end is below the bottom edge.
        var fromEnd: Double
        var viewport: Double
        /// A gesture or its momentum is still moving the feed.
        var moving: Bool
        /// A history window is open, and whether it is joined to the live tail.
        var windowOpen: Bool
        var joined: Bool
        /// The last read the bridge was sent left the window following the end.
        var followsEnd: Bool
        var loading: Bool
        /// The slack within which the feed counts as at the end.
        var atEndSlack: Double
    }

    static func decide(_ facts: Facts) -> TranscriptEndRead {
        guard !facts.loading else { return .none }
        let atEnd = facts.fromEnd <= facts.atEndSlack
        // Holding is owed while nothing holds the reader's rows: no window yet, or one that
        // still follows the end.
        let holding = facts.windowOpen && !facts.followsEnd
        if !holding {
            let far = facts.moving ? facts.fromEnd > facts.viewport : !atEnd
            return far ? .hold : .none
        }
        if !facts.moving, atEnd, facts.joined { return .follow }
        return .none
    }
}
