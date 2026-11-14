/// When the feed takes the row at the top as the one to hold, from scroll and layout events in
/// the order SwiftUI delivers them.
///
/// After the person's drag, the capture taken at idle may predate the scroll's last origin
/// report, so the first settled origin report refreshes it. A row laying out first means content
/// changed, not the scroll: the idle capture stands and the feed corrects drift against it, so a
/// resize can never move the target. A turn-key jump captures where its animation settles. Pure:
/// events in, "capture now" out.
struct TranscriptCaptureSchedule: Equatable, Sendable {
    enum Event: Equatable, Sendable {
        /// The person touched the feed.
        case gestureBegan
        /// The person's scroll came to rest; `reading` when it left the feed away from the end.
        case gestureEnded(reading: Bool)
        /// A scroll the person didn't make began (the status bar, VoiceOver, the feed's own).
        case scrollStarted
        /// The content's origin moved on screen; `moving` while a scroll is still in flight.
        case originReported(moving: Bool)
        /// A row on screen changed place or height in the content.
        case rowLaidOut
        /// The feed scrolled itself to a turn with an animation.
        case jumped
        /// A scroll the person didn't make came to rest.
        case settled
    }

    private var afterGesture = false
    private var afterJump = false

    /// Applies `event`; true when the feed should capture the top row now.
    mutating func next(_ event: Event) -> Bool {
        switch event {
        case .gestureBegan:
            afterGesture = false
            afterJump = false
        case .gestureEnded(let reading):
            afterGesture = reading
        case .scrollStarted, .rowLaidOut:
            afterGesture = false
        case .originReported(let moving):
            if moving { afterGesture = false; return false }
            defer { afterGesture = false }
            return afterGesture
        case .jumped:
            afterGesture = false
            afterJump = true
        case .settled:
            defer { afterJump = false }
            return afterJump
        }
        return false
    }
}
