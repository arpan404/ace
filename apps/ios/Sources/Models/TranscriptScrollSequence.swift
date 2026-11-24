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
///   drag takes the scroll from it. The scroll rests once both the finger and the animation
///   are done, whichever finishes first, and what was held under the tap lands then.
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
    /// The feed's animated scroll hasn't reported its end yet.
    private var running = false
    /// Counts the feed's animated scrolls, so a late check can't end a later one.
    private var animation = 0

    /// An offset write now would land under a finger or a fling.
    var holdsWindow: Bool { phase.isReaders || touched }

    /// What waits lands only at rest: a change held under a tap mid-animation waits for the
    /// animation too.
    private var keepsHolding: Bool { holdsWindow || phase == .animating }

    /// A window change arrived. True when it must wait; a change that moves nothing, or one
    /// made at rest, replaces whatever waited. `movesOffset` is asked only while holding.
    mutating func windowChange(movesOffset: () -> Bool) -> Bool {
        holding = (holdsWindow || holding && keepsHolding) && movesOffset()
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
            case .animating:
                if running { extra.append(.checkAnimation(animation)) } else { next = .idle }
            case .idle, .interacting: break
            }
        case .dragBegan:
            running = false
            next = .interacting
        case .dragEnded(let decelerates):
            touched = false
            next = decelerates ? .decelerating : .idle
        case .decelerationEnded:
            // A touch that caught the fling and lifted while it still ran rests here.
            if phase == .decelerating || phase == .tracking && !touched { next = .idle }
        case .animationStarting:
            forcesLanding = true
        case .animationStarted:
            animation += 1
            running = true
            next = .animating
        case .animationEnded:
            guard phase == .animating else { break }
            running = false
            if !touched { next = .idle }
        case .animationOverdue(let which):
            guard phase == .animating, running, which == animation, !touched else { break }
            running = false
            next = .idle
        case .assistiveBegan:
            next = .interacting
        case .assistiveEnded:
            if phase == .interacting { next = .idle }
        }
        phase = next
        var actions: [Action] = []
        if holding, forcesLanding || !keepsHolding {
            holding = false
            actions += [.land, .report]
        }
        if next != old { actions.append(.phase(old: old, new: next)) }
        return actions + extra
    }
}
