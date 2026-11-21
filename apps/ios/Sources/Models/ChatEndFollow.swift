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
/// when a scroll comes to rest at the end (theirs, VoiceOver's, the status bar's), or they send.
/// Growth (a streaming reply, rows measuring, the keyboard) is no scroll and never decides it: while it doesn't follow, the rows the person reads
/// hold still. The same rule as the thread's transcript (`ConversationFeed`), without its history
/// windows. Pure.
struct ChatEndFollow: Equatable, Sendable {
    /// How close to the end a resting scroll counts as at it, in points.
    let slack: Double
    private(set) var following = true
    /// A finger is on the scroll, or its fling hasn't come to rest.
    private var touching = false

    init(slack: Double) { self.slack = slack }

    /// Whether the rows may move to another stack now. Only at the end: a switch can shift the
    /// rows a reader looking back is on (`TranscriptStackChoice`).
    var mayRestack: Bool { following }

    /// The person put a finger on the scroll.
    mutating func touched() { touching = true }

    /// The scroll moved while the person held or flung it.
    mutating func scrolled(towardOlder: Bool) {
        if touching, towardOlder { following = false }
    }

    /// A scroll came to rest, `fromEnd` above the end in a `viewport` this tall. Only a scroll's
    /// phase ending calls it, never a change of size: at the end it follows again, however the
    /// scroll was made and however following had stopped (a drag, VoiceOver, a card's jump).
    mutating func rested(fromEnd: Double, viewport: Double) {
        if fromEnd <= slack {
            following = true
        } else if touching {
            following = false
        } else if TranscriptEndButton.leftByOtherScroll(following: following, fromEnd: fromEnd, viewport: viewport, settling: false) {
            // Moved a screen away by something other than a drag (the status bar, VoiceOver).
            following = false
        }
        touching = false
    }

    /// The person sent a message: the chat goes to its end, wherever they were.
    mutating func sent() {
        following = true
        touching = false
    }

    /// The feed jumped to a row the person asked for (a card for later).
    mutating func jumped() { following = false }
}

/// Whether a drag has moved back toward older messages: by more than a point from the newest
/// place it reached since it began, however little each frame moved it. Pure.
struct DragTravel: Equatable, Sendable {
    /// The largest content offset since the drag began: the newest messages it showed.
    private var newest: Double?

    /// A finger went down with the content at offset `y`.
    mutating func began(at y: Double) { newest = y }

    /// The content moved to offset `y`. True once it is more than a point back toward older
    /// messages from the newest place reached.
    mutating func moved(to y: Double) -> Bool {
        let peak = max(newest ?? y, y)
        newest = peak
        return y < peak - 1
    }
}
