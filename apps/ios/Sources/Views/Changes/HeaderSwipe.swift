import SwiftUI
import UIKit

/// What a sideways swipe on a changed file's header decides, pure: whether a drag is the
/// header's at all, how far the row follows the finger, and whether letting go marks the file.
enum HeaderSwipe {
    /// A drag at least twice as sideways as it is steep; anything else scrolls the list.
    static func begins(dx: CGFloat, dy: CGFloat) -> Bool { abs(dx) > abs(dy) * 2 }
    static func offset(_ translation: CGFloat, reach: CGFloat) -> CGFloat { max(-reach, min(reach, translation)) }
    static func marks(_ offset: CGFloat, reach: CGFloat) -> Bool { abs(offset) >= reach * 0.8 }
}

/// The header's sideways swipe as a UIKit pan, so it can win over a scroll view's pan: the
/// phone's Chat/Changes pager took every sideways drag from the SwiftUI drag the header had.
/// Scroll views' pans wait for this one to fail, and it fails at once unless the drag is
/// sideways (`HeaderSwipe.begins`), so the list scrolls as before and a swipe that starts
/// anywhere but a header still pages.
struct HeaderSwipeGesture: UIGestureRecognizerRepresentable {
    /// The finger's sideways travel while the swipe lasts.
    let changed: (CGFloat) -> Void
    /// The travel when the finger lifts; 0 when the swipe was cancelled.
    let ended: (CGFloat) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        return pan
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIPanGestureRecognizer, context: Context) {
        let travel = recognizer.translation(in: recognizer.view).x
        switch recognizer.state {
        case .began, .changed: changed(travel)
        case .ended: ended(travel)
        case .cancelled, .failed: ended(0)
        default: break
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    @MainActor final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer else { return false }
            let velocity = pan.velocity(in: pan.view)
            return HeaderSwipe.begins(dx: velocity.x, dy: velocity.y)
        }
        /// A scroll view's pan (the pager's, the list's) waits until this swipe has failed.
        func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            other is UIPanGestureRecognizer && other.view is UIScrollView
        }
    }
}
