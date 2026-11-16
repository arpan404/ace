import SwiftUI
import UIKit

/// How far the docked keyboard lifts the thread's foot, frame by frame: one value the composer
/// (`FloatingBar`) and the rows following the transcript's end (`ConversationFeed`) are both
/// drawn by, so the two move as one (#2170). Each frame sets it from where the keyboard's edge is
/// drawn on that frame (`KeyboardEdgeTracker`), so the composer sits on the keyboard; only when
/// no edge can be read does it fall back to the keyboard's fitted curve (`KeyboardCurve`). A
/// SwiftUI animation would start when its change commits, frames after the keyboard does. Only
/// the small offset modifiers read `lift`, so a frame redraws them and nothing under them.
@MainActor @Observable final class KeyboardRide {
    /// The lift drawn this frame.
    private(set) var lift: CGFloat = 0
    /// Where the current move ends.
    private(set) var target: CGFloat = 0
    /// The notified duration of the latest move.
    private(set) var duration = 0.35
    /// Bumped as each move starts and as each one lands.
    private(set) var moves = 0
    private(set) var landings = 0
    /// Reads where the keyboard is drawn; `KeyboardEdgeReader` gives it its view.
    @ObservationIgnored let edges = KeyboardEdgeTracker()
    /// Calls the ride once a frame while a move runs.
    @ObservationIgnored private let clock: any KeyboardFrameClock
    @ObservationIgnored private var move: Move?

    /// `clock` defaults to the display; tests pass their own.
    init(clock: (any KeyboardFrameClock)? = nil) {
        self.clock = clock ?? DisplayLinkClock()
    }

    // A ride let go of mid-move stops its frames too, not only at the next tick.
    isolated deinit {
        clock.stop()
    }

    private struct Move {
        let from: CGFloat
        let start: CFTimeInterval
        let duration: Double
        /// The foot of the area the composer rests at, in window points: the lift is how far the
        /// keyboard's edge is above it.
        let foot: CGFloat
        /// Whether the keyboard's edge has been seen moving in this move: until then a still edge
        /// is one whose animation UIKit hasn't added yet, not one that has arrived.
        var edgeMoved = false
    }

    var running: Bool { move != nil }

    /// Moves the lift to `target` with the keyboard, for a move announced at `start`
    /// (`CACurrentMediaTime`) lasting `duration` over a column whose foot is at `foot`;
    /// `animated: false` puts it there at once.
    func move(to target: CGFloat, foot: CGFloat, start: CFTimeInterval, duration: Double, animated: Bool) {
        guard target != self.target else { return }
        self.target = target
        self.duration = duration
        moves += 1
        guard animated else {
            land()
            return
        }
        // A move under way goes on from where it's drawn.
        move = Move(from: lift, start: start, duration: duration, foot: foot)
        // The clock holds the ride weakly: a ride that's gone ends its frames.
        clock.start { [weak self] frame in
            guard let self else { return false }
            self.tick(frame)
            return self.running
        }
    }

    /// Ends a move where it's going: the thread left the screen or the app the foreground.
    func finish() {
        guard running else { return }
        land()
    }

    private func land() {
        clock.stop()
        move = nil
        lift = target
        landings += 1
    }

    private func tick(_ frame: KeyboardFrame) {
        guard let move else { return }
        if let reading = edges.reading(at: frame.shown, notified: move.start) {
            let measured = max(0, move.foot - reading.y)
            if reading.moving {
                self.move?.edgeMoved = true
                PerfProbe.add("keyboard.source.\(reading.source.rawValue)", 1)
                lift = measured
                return
            }
            let over = frame.now - move.start > move.duration + 0.1
            if move.edgeMoved || over, abs(measured - target) < 0.5 {
                lift = measured
                land()
                return
            }
        }
        // No animation to read yet (UIKit adds the keyboard's a tick after the notification), or
        // none at all: the fitted curve, at the time the lift reaches the screen.
        PerfProbe.add("keyboard.source.curve", 1)
        let elapsed = frame.shown - move.start
        let distance = Double(target - move.from)
        // A rising lift is the keyboard opening.
        let delay = distance > 0 ? KeyboardCurve.openingDelay : KeyboardCurve.closingDelay
        if KeyboardCurve.settled(elapsed, duration: move.duration, delay: delay, distance: distance) {
            land()
            return
        }
        lift = move.from + CGFloat(distance * KeyboardCurve.progress(elapsed, duration: move.duration, delay: delay))
    }
}

/// One display frame's times, on the `CACurrentMediaTime` clock.
struct KeyboardFrame {
    /// When this frame started.
    let now: CFTimeInterval
    /// When what's set now reaches the screen: a frame after the frame it's computed for,
    /// measured on the simulator as the composer trailing the keyboard by exactly one frame.
    let shown: CFTimeInterval
}

/// Calls `frame` once per display frame until it returns false or `stop` is called.
@MainActor protocol KeyboardFrameClock: AnyObject {
    func start(_ frame: @escaping @MainActor (KeyboardFrame) -> Bool)
    func stop()
}

/// The display's frames, from a display link. The run loop holds the link and the link its
/// target, so a frame handler that answers false invalidates the link from inside its own tick:
/// once its ride is gone, nothing else is left to.
@MainActor final class DisplayLinkClock: KeyboardFrameClock {
    private var link: CADisplayLink?
    private var ticker: FrameTicker?

    func start(_ frame: @escaping @MainActor (KeyboardFrame) -> Bool) {
        // One link per clock: a move under way keeps it and takes the new handler.
        if link != nil, let ticker {
            ticker.frame = frame
            return
        }
        let ticker = FrameTicker(frame)
        ticker.ended = { [weak self] in self?.link = nil; self?.ticker = nil }
        let link = CADisplayLink(target: ticker, selector: #selector(FrameTicker.tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
        self.ticker = ticker
    }

    func stop() {
        link?.invalidate()
        link = nil
        ticker = nil
    }
}

/// The display link's target, calling the clock's handler.
private final class FrameTicker: NSObject {
    var frame: @MainActor (KeyboardFrame) -> Bool
    /// Tells the clock its link is gone.
    var ended: (@MainActor () -> Void)?
    init(_ frame: @escaping @MainActor (KeyboardFrame) -> Bool) { self.frame = frame }
    @MainActor @objc func tick(_ link: CADisplayLink) {
        let ahead = link.targetTimestamp - link.timestamp
        guard !frame(KeyboardFrame(now: link.timestamp, shown: link.targetTimestamp + ahead)) else { return }
        link.invalidate()
        ended?()
    }
}

/// Draws its content up by the ride's lift beyond `base`, the lift the content is already laid
/// out or scrolled for; nothing while `riding` is off. The only views that read the lift.
struct KeyboardRideOffset: ViewModifier {
    let ride: KeyboardRide
    var base: CGFloat = 0
    var riding = true
    func body(content: Content) -> some View {
        content.offset(y: riding ? base - ride.lift : 0)
    }
}
