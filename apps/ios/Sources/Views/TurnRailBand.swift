import SwiftUI
import UIKit

/// The turn rail's edge band as UIKit recognizers on the feed, not on the band, so the band takes
/// no touches and the transcript's own pan keeps every swipe. Both take only touches that start on
/// the band (`TurnRail.bandTakes`). A finger resting there `TurnRail.hold` seconds starts a
/// scrub, and the transcript's pan is turned off until it lifts. A finger that moves `slop` first
/// fails the hold and the pan scrolls as before. A tap jumps once the hold has failed.
enum TurnRailBand {
    /// Hold, then drag to scrub; lifting jumps.
    struct Hold: UIGestureRecognizerRepresentable {
        let place: TurnRailPlace

        func makeUIGestureRecognizer(context: Context) -> UILongPressGestureRecognizer {
            let hold = UILongPressGestureRecognizer()
            hold.minimumPressDuration = TurnRail.hold
            hold.allowableMovement = TurnRail.slop
            hold.cancelsTouchesInView = false
            hold.delegate = context.coordinator
            return hold
        }

        func handleUIGestureRecognizerAction(_ recognizer: UILongPressGestureRecognizer, context: Context) {
            let y = recognizer.location(in: nil).y - (place.band?.minY ?? 0)
            switch recognizer.state {
            case .began:
                context.coordinator.holdScroll(recognizer)
                place.fingerMoved(to: y)
            case .changed: place.fingerMoved(to: y)
            case .ended:
                context.coordinator.releaseScroll()
                place.fingerLifted(at: y)
            case .cancelled, .failed:
                context.coordinator.releaseScroll()
                place.fingerLifted(at: nil)
            default: break
            }
        }

        func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator(place: place) }

        @MainActor final class Coordinator: NSObject, UIGestureRecognizerDelegate {
            let place: TurnRailPlace
            /// The transcript's pan, off while a scrub lasts.
            private weak var held: UIPanGestureRecognizer?
            init(place: TurnRailPlace) { self.place = place }
            func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
                TurnRail.bandTakes(touch.location(in: nil), band: place.band)
            }
            /// The transcript's pan keeps the touch alongside it, so a swipe still scrolls; once the
            /// hold begins it turns that pan off (`holdScroll`). Any other press (a row's menu) loses.
            func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
                other is UIPanGestureRecognizer && other.view is UIScrollView
            }
            /// The scroll view under the finger stops scrolling for the scrub: turning its pan off
            /// cancels it, and it comes back when the finger lifts.
            func holdScroll(_ recognizer: UIGestureRecognizer) {
                guard let window = recognizer.view?.window else { return }
                var view = window.hitTest(recognizer.location(in: window), with: nil)
                while let current = view, !(current is UIScrollView) { view = current.superview }
                guard let pan = (view as? UIScrollView)?.panGestureRecognizer else { return }
                pan.isEnabled = false
                held = pan
            }
            func releaseScroll() {
                held?.isEnabled = true
                held = nil
            }
        }
    }

    /// A tap on the band jumps to the tick under it, once the hold has failed.
    struct Tap: UIGestureRecognizerRepresentable {
        let place: TurnRailPlace

        func makeUIGestureRecognizer(context: Context) -> UITapGestureRecognizer {
            let tap = UITapGestureRecognizer()
            tap.cancelsTouchesInView = false
            tap.delegate = context.coordinator
            return tap
        }

        func handleUIGestureRecognizerAction(_ recognizer: UITapGestureRecognizer, context: Context) {
            guard recognizer.state == .ended else { return }
            place.fingerLifted(at: recognizer.location(in: nil).y - (place.band?.minY ?? 0))
        }

        func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator(place: place) }

        @MainActor final class Coordinator: NSObject, UIGestureRecognizerDelegate {
            let place: TurnRailPlace
            init(place: TurnRailPlace) { self.place = place }
            func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
                TurnRail.bandTakes(touch.location(in: nil), band: place.band)
            }
            func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
                !(other is UILongPressGestureRecognizer && other.delegate is Hold.Coordinator)
            }
            /// A held touch is the hold's: the tap waits for it to fail.
            func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRequireFailureOf other: UIGestureRecognizer) -> Bool {
                other is UILongPressGestureRecognizer && other.delegate is Hold.Coordinator
            }
        }
    }
}
