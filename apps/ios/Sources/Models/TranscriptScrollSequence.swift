/// What the scroll view is doing, as SwiftUI's `ScrollPhase` names it.
enum TranscriptScrollPhase: Sendable {
    case idle, tracking, interacting, decelerating, animating

    /// A finger is down or a fling it started is running: the reader's own motion.
    var isReaders: Bool { self == .tracking || self == .interacting || self == .decelerating }
}

/// The transcript collection's scroll phase and the window change it holds for it (ADR 0222),
/// decided apart from UIKit. The collection hands it what the scroll view and its touches report
/// and does what it returns, in order:
///
/// - A window change that would move the offset waits while a finger is down or a fling runs,
///   and lands, with its geometry reported, before the feed hears the scroll came to rest.
/// - An animated jump lands what waits before it picks its target, so it aims at the window
///   it scrolls in.
/// - A tap during the feed's own animated scroll leaves the animation's phase alone; only a
///   drag takes the scroll from it.
struct TranscriptScrollSequence: Sendable {
    enum Event: Equatable, Sendable {
        /// A finger came down on the transcript.
        case touchDown
        /// A touch lifted. `scrolling`: a drag or a fling is still going.
        case touchUp(scrolling: Bool)
        case dragBegan
        case dragEnded(decelerates: Bool)
        case decelerationEnded
        /// The feed is about to pick an animated scroll's target.
        case animationStarting
        case animationStarted
        case animationEnded
        /// The check asked for with `checkAnimation` came due.
        case animationOverdue(Int)
        /// VoiceOver's three-finger swipe or Switch Control began or ended a page.
        case assistiveBegan, assistiveEnded
    }

    enum Action: Equatable, Sendable {
        /// Lay out the window change that waited.
        case land
        /// Report the rows and the scroll geometry as they are now.
        case report
        /// Tell the feed the phase moved.
        case phase(old: TranscriptScrollPhase, new: TranscriptScrollPhase)
        /// A tap may have stopped the animation without UIKit reporting its end: send
        /// `animationOverdue` with this value once an animation would have ended.
        case checkAnimation(Int)
    }

    private(set) var phase = TranscriptScrollPhase.idle
    /// A window change waits for the scroll to come to rest.
    private(set) var holding = false
    /// A finger is down that no drag has taken yet.
    private var touched = false
    /// Counts the feed's animated scrolls, so a late check can't end a later one.
    private var animation = 0

    /// An offset write now would land under a finger or a fling.
    var holdsWindow: Bool { phase.isReaders || touched }

    /// A window change arrived. True when it must wait; a change that moves nothing, or one
    /// made at rest, replaces whatever waited. `movesOffset` is asked only while holding.
    mutating func windowChange(movesOffset: () -> Bool) -> Bool {
        holding = holdsWindow && movesOffset()
        return holding
    }

    mutating func handle(_ event: Event) -> [Action] {
        let old = phase
        var next = phase
        var extra: [Action] = []
        var forcesLanding = false
        switch event {
        case .touchDown:
            touched = true
            if phase == .idle || phase == .decelerating { next = .tracking }
        case .touchUp(let scrolling):
            touched = false
            switch phase {
            case .tracking, .decelerating: if !scrolling { next = .idle }
            case .animating: extra.append(.checkAnimation(animation))
            case .idle, .interacting: break
            }
        case .dragBegan:
            next = .interacting
        case .dragEnded(let decelerates):
            touched = false
            next = decelerates ? .decelerating : .idle
        case .decelerationEnded:
            if phase == .decelerating { next = .idle }
        case .animationStarting:
            forcesLanding = true
        case .animationStarted:
            animation += 1
            next = .animating
        case .animationEnded:
            if phase == .animating { next = .idle }
        case .animationOverdue(let which):
            if phase == .animating, which == animation, !touched { next = .idle }
        case .assistiveBegan:
            next = .interacting
        case .assistiveEnded:
            if phase == .interacting { next = .idle }
        }
        phase = next
        var actions: [Action] = []
        if holding, forcesLanding || !holdsWindow {
            holding = false
            actions += [.land, .report]
        }
        if next != old { actions.append(.phase(old: old, new: next)) }
        return actions + extra
    }
}
