import CoreGraphics

/// Where the transcript holds the reader, decided from geometry and scroll events in whatever
/// order SwiftUI delivers them. Pure: events and the feed's facts in, actions out. The feed
/// forwards every row layout, origin report and scroll phase, and performs what comes back.
///
/// - After the person's drag comes to rest, the row at the top is held, and every origin report
///   while the feed stays still refreshes it: idle can arrive before the scroll's last report.
///   Only the held row being displaced (it, or a row above it, changed height) ends that, so a
///   row appearing elsewhere never freezes a stale place.
/// - A turn-key jump holds the turn it asked for, refreshed to where it lands, until the next
///   scroll or a displacement.
/// - A focused open's row (`TranscriptFocusLanding`) owns the place while it lands: nothing is
///   captured, refreshed or put back meanwhile. Once shown, it is held where it landed, like a
///   landed jump.
/// - A held row displaced while the feed is still is put back. While a scroll runs the
///   correction is owed, not dropped, and runs once the scroll ends; an animation that never
///   reports its end counts as ended after `animationLimit`. A new gesture drops what's owed.
struct TranscriptPlaceKeeper: Sendable {
    /// What the feed allows, read when each event arrives.
    struct Facts: Equatable, Sendable {
        /// The anchor the feed holds now (the viewport controller owns it).
        var held: TranscriptHeldAnchor?
        /// The header's height over the viewport's top.
        var inset: CGFloat
        /// A focus is landing and owns the place until its row has been shown.
        var focusLanding = false
        /// Reading away from the end with no jump re-aiming and no session restore pending.
        var mayCapture: Bool
        /// Correction budget left, no VoiceOver, not following, no session restore pending.
        var mayCorrect: Bool
    }

    enum Phase: Equatable, Sendable {
        /// The person's finger, or the fling after it.
        case gesture
        /// A scroll the person didn't make: the feed's own, the status bar, VoiceOver.
        case animating
        case idle
    }

    enum Event: Equatable, Sendable {
        /// A row was laid out at this frame in the content.
        case laidOut(String, CGRect)
        /// A row left the screen.
        case gone(String)
        /// The content's top is here in the viewport.
        case origin(CGFloat)
        case phase(Phase)
        /// The feed is scrolling, with an animation, to put this row at the top.
        case jumped(String)
        /// A focused open's row has been shown: hold it where it is.
        case focusLanded(String)
        /// The feed put the held row back itself (rows changed under it): check where it lands.
        case placedHeldRow
        /// Time passed with nothing else to report: the fallback for an animation that never ends.
        case tick
    }

    enum Action: Equatable, Sendable {
        /// Hold `rowID`, `top` points below the header: the anchor to correct to and save.
        case hold(rowID: String, top: Double)
        /// Scroll so `rowID` sits `top` points below the header.
        case place(rowID: String, top: Double)
    }

    /// Longest a scroll the person didn't make may report itself running, in milliseconds.
    static let animationLimit: Double = 1_500

    private enum Follow: Equatable, Sendable {
        /// The top row after a drag.
        case drag
        /// The jump's row; `landed` once its scroll has come to rest.
        case jump(String, landed: Bool)
    }

    private(set) var frames = TranscriptRowFrames()
    /// What the last `laidOut` found.
    private(set) var lastLayout = TranscriptRowFrames.Change.unchanged
    private var phase = Phase.idle
    private var animatingSince = 0.0
    /// Which settled place the held anchor follows, if any.
    private var follow: Follow?
    /// The held row may sit off its place: check it the next time the feed is still.
    private var owed = false

    mutating func next(_ event: Event, facts: Facts, now: Double) -> [Action] {
        var step = Step(facts: facts)
        switch event {
        case .laidOut(let id, let frame):
            lastLayout = frames.record(id, frame: frame)
            let displaced = lastLayout == .moved || lastLayout == .resized
            guard displaced, id == step.held?.rowID else { break }
            // Content moved under the held row: its place is now a target, not a reading.
            if case .jump(_, landed: false) = follow {} else { follow = nil }
            check(&step)
        case .gone(let id):
            frames.forget(id)
        case .origin(let origin):
            guard frames.scrolled(origin: origin), phase == .idle else { break }
            refresh(&step)
            if owed { check(&step) }
        case .phase(let next):
            enter(next, now: now, &step)
        case .jumped(let id):
            owed = false
            follow = .jump(id, landed: false)
            step.hold(id, top: 0)
        case .focusLanded(let id):
            owed = false
            follow = .jump(id, landed: true)
            if let top = frames.top(id, inset: step.facts.inset) { step.hold(id, top: top) }
        case .placedHeldRow:
            follow = nil
            owed = true
        case .tick:
            if phase == .animating, now - animatingSince >= Self.animationLimit { enter(.idle, now: now, &step) }
        }
        return step.actions
    }

    private mutating func enter(_ next: Phase, now: Double, _ step: inout Step) {
        let was = phase
        // The phase changes before anything is decided, so a check at idle can run.
        phase = next
        switch next {
        case .gesture:
            guard was != .gesture else { return }
            follow = nil
            owed = false
        case .animating:
            if was != .animating { animatingSince = now }
            // A scroll after the jump landed isn't the jump's.
            if follow == .drag { follow = nil }
            if case .jump(_, landed: true) = follow { follow = nil }
        case .idle:
            if was == .gesture { follow = step.facts.mayCapture ? .drag : nil }
            if was == .animating, case .jump(let id, _) = follow { follow = .jump(id, landed: true) }
            refresh(&step)
            if owed { check(&step) }
        }
    }

    /// The held anchor follows the settled place it tracks.
    private func refresh(_ step: inout Step) {
        guard !step.facts.focusLanding else { return }
        switch follow {
        case .drag:
            guard step.facts.mayCapture, let id = frames.topRow(inset: step.facts.inset),
                let top = frames.top(id, inset: step.facts.inset) else { return }
            step.hold(id, top: top)
        case .jump(let id, _):
            // Something else took the hold (a disclosure, a restore): the jump no longer owns it.
            guard step.held?.rowID == id, let top = frames.top(id, inset: step.facts.inset) else { return }
            step.hold(id, top: top)
        case nil:
            return
        }
    }

    /// Puts the held row back if it drifted, or keeps the correction owed while a scroll runs.
    private mutating func check(_ step: inout Step) {
        guard let held = step.held, let top = frames.top(held.rowID, inset: step.facts.inset),
            TranscriptRowPlacement.drift(top: top, target: held.top) != nil else { owed = false; return }
        guard phase == .idle else { owed = true; return }
        guard step.facts.mayCorrect, !step.facts.focusLanding else { owed = false; return }
        step.actions.append(.place(rowID: held.rowID, top: held.top))
        // Check again where the correction lands.
        owed = true
    }

    /// One event's actions, and the held anchor as they leave it.
    private struct Step {
        let facts: Facts
        var held: TranscriptHeldAnchor?
        var actions: [Action] = []
        init(facts: Facts) { self.facts = facts; held = facts.held }
        mutating func hold(_ id: String, top: Double) {
            guard held?.rowID != id || held?.top != top else { return }
            held = TranscriptHeldAnchor(rowID: id, itemID: held?.rowID == id ? held?.itemID : nil, top: top)
            actions.append(.hold(rowID: id, top: top))
        }
    }
}
