import UIKit

/// Hears every touch on the transcript without taking it.
final class TranscriptTouchWatcher: UIGestureRecognizer {
    var landed: (() -> Void)?
    var lifted: (() -> Void)?

    override init(target: Any?, action: Selector?) {
        super.init(target: target, action: action)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        landed?()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        lifted?()
        state = .failed
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        lifted?()
        state = .failed
    }
}
