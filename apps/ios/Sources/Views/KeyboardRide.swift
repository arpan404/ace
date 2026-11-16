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
    @ObservationIgnored private var link: CADisplayLink?
    @ObservationIgnored private var move: Move?

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
        guard link == nil else { return }
        let link = CADisplayLink(target: RideTicker(ride: self), selector: #selector(RideTicker.tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    private func land() {
        link?.invalidate()
        link = nil
        move = nil
        lift = target
        landings += 1
    }

    fileprivate func tick(_ link: CADisplayLink) {
        guard let move else { return }
        // Where the keyboard is drawn when what's set now reaches the screen: a lift set in this
        // tick shows a frame after the frame it's computed for, measured on the simulator as the
        // composer trailing the keyboard by exactly one frame.
        let frame = link.targetTimestamp - link.timestamp
        if let reading = edges.reading(at: link.targetTimestamp + frame) {
            let measured = max(0, move.foot - reading.y)
            if reading.moving {
                self.move?.edgeMoved = true
                PerfProbe.add("keyboard.source.\(reading.source.rawValue)", 1)
                lift = measured
                return
            }
            let over = link.timestamp - move.start > move.duration + 0.1
            if move.edgeMoved || over, abs(measured - target) < 0.5 {
                lift = measured
                land()
                return
            }
        }
        // No animation to read yet, or none at all: the fitted curve, from the frame's own time.
        PerfProbe.add("keyboard.source.curve", 1)
        let elapsed = link.timestamp - move.start
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

/// The display link's target: a link holds its target strongly, so the ride isn't it.
private final class RideTicker: NSObject {
    weak var ride: KeyboardRide?
    init(ride: KeyboardRide) { self.ride = ride }
    @MainActor @objc func tick(_ link: CADisplayLink) { ride?.tick(link) }
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
