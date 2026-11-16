import SwiftUI
import UIKit

/// The rows following the transcript's end as the keyboard moves: drawn `shift` points from
/// where the scroll puts them, set every frame from the keyboard's curve (`KeyboardCurve`) at the
/// time the frame is shown, measured from the notification less the curve's `delay`. A SwiftUI animation would start when
/// its change commits, frames after the keyboard does; this lands each frame where the keyboard
/// is, hitches included (#2170). Only `KeyboardRideOffset` reads `shift`, so a frame redraws the
/// offset and nothing under it.
@MainActor @Observable final class KeyboardRide {
    private(set) var shift: CGFloat = 0
    @ObservationIgnored private var link: CADisplayLink?
    @ObservationIgnored private var move: Move?

    private struct Move {
        let from: CGFloat
        let to: CGFloat
        let start: CFTimeInterval
        let duration: Double
        let done: () -> Void
    }

    var running: Bool { move != nil }

    /// Draws the rows `shift` points off at once, ending any ride.
    func hold(at shift: CGFloat) {
        stop()
        self.shift = shift
    }

    /// Rides from `from` to `to` on the keyboard's curve for a move announced at `start`
    /// (`CACurrentMediaTime`), then calls `done`.
    func ride(from: CGFloat, to: CGFloat, start: CFTimeInterval, duration: Double, done: @escaping () -> Void) {
        stop()
        shift = from
        move = Move(from: from, to: to, start: start, duration: duration, done: done)
        let link = CADisplayLink(target: RideTicker(ride: self), selector: #selector(RideTicker.tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    /// Ends a ride where it was going, without calling its `done`.
    func stop() {
        link?.invalidate()
        link = nil
        if let move { shift = move.to }
        move = nil
    }

    fileprivate func tick(_ link: CADisplayLink) {
        guard let move else { return }
        let elapsed = link.targetTimestamp - move.start - KeyboardCurve.delay
        let distance = Double(move.to - move.from)
        if KeyboardCurve.settled(elapsed, duration: move.duration, distance: distance) {
            stop()
            move.done()
            return
        }
        shift = move.from + CGFloat(distance * KeyboardCurve.progress(elapsed, duration: move.duration))
    }
}

/// The display link's target: a link holds its target strongly, so the ride isn't it.
private final class RideTicker: NSObject {
    weak var ride: KeyboardRide?
    init(ride: KeyboardRide) { self.ride = ride }
    @MainActor @objc func tick(_ link: CADisplayLink) { ride?.tick(link) }
}

/// Draws its content `ride.shift` points down; the only view that reads it.
struct KeyboardRideOffset: ViewModifier {
    let ride: KeyboardRide
    func body(content: Content) -> some View {
        content.offset(y: ride.shift)
    }
}
