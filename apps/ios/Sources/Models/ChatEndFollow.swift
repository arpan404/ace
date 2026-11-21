/// How far a vertical scroll's end is below the bottom edge of what shows, in points: negative
/// only past the end. The transcript and Spade's chat measure it the same way.
enum ScrollEnd {
    /// `containerHeight` is the area inside the insets; `offsetY` the content offset, which
    /// starts at `-topInset` with the content's top under the header.
    static func fromEnd(contentHeight: Double, offsetY: Double, containerHeight: Double, topInset: Double) -> Double {
        contentHeight - offsetY - containerHeight - topInset
    }
}

/// Whether a messenger-style chat keeps its end on screen (Spade's conversation). It follows from
/// opening, stops the moment the person drags back toward older messages, and follows again only
/// when their own scroll comes to rest at the end, or they send. Growth (a streaming reply, rows
/// measuring, the keyboard) never decides it: while it doesn't follow, the rows the person reads
/// hold still. The same rule as the thread's transcript (`ConversationFeed`), without its history
/// windows. Pure.
struct ChatEndFollow: Equatable, Sendable {
    /// How close to the end a resting scroll counts as at it, in points.
    let slack: Double
    private(set) var following = true
    /// A finger is on the scroll, or its fling hasn't come to rest.
    private var touching = false

    init(slack: Double) { self.slack = slack }

    /// The person put a finger on the scroll.
    mutating func touched() { touching = true }

    /// The scroll moved while the person held or flung it.
    mutating func scrolled(towardOlder: Bool) {
        if touching, towardOlder { following = false }
    }

    /// The scroll came to rest, `fromEnd` above the end in a `viewport` this tall.
    mutating func rested(fromEnd: Double, viewport: Double) {
        if touching {
            following = fromEnd <= slack
            touching = false
        } else if TranscriptEndButton.leftByOtherScroll(following: following, fromEnd: fromEnd, viewport: viewport, settling: false) {
            // Moved a screen away by something other than a drag (the status bar, VoiceOver).
            following = false
        }
    }

    /// The person sent a message: the chat goes to its end, wherever they were.
    mutating func sent() {
        following = true
        touching = false
    }

    /// The feed jumped to a row the person asked for (a card for later).
    mutating func jumped() { following = false }
}
