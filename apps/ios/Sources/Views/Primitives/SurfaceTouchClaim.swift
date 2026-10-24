import UIKit

/// Keeps a finger that lands on a remote surface (a device, a Mac app window, a live page) for
/// that surface. Navigation's back swipes (the edge one and the full-width one), a sheet's
/// dismiss drag and any scroll view around the surface must wait for this to fail, and it never
/// fails while the finger is down. Touches still reach the surface's own `touches…` methods as
/// they happen. Fingers that land anywhere else, the bar above included, go back as usual.
///
/// Turn it off with `isEnabled` while the person can only watch, so a swipe there goes back.
final class SurfaceTouchClaim: UIGestureRecognizer {
    private var down = 0

    init() {
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    /// Adds a claim to `view`, enabled to start with.
    @discardableResult static func install(on view: UIView) -> SurfaceTouchClaim {
        let claim = SurfaceTouchClaim()
        view.addGestureRecognizer(claim)
        return claim
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        down += touches.count
        state = state == .possible ? .began : .changed
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        if state == .began || state == .changed { state = .changed }
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        down = max(0, down - touches.count)
        if down == 0 { state = .ended }
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        down = max(0, down - touches.count)
        if down == 0 { state = .cancelled }
    }
    override func reset() {
        super.reset()
        down = 0
    }

    /// Every recognizer outside the surface (on its ancestors) waits for this one.
    override func shouldBeRequiredToFail(by other: UIGestureRecognizer) -> Bool {
        guard let view, let otherView = other.view else { return false }
        return !otherView.isDescendant(of: view)
    }
    override func canBePrevented(by preventing: UIGestureRecognizer) -> Bool {
        guard let view, let otherView = preventing.view else { return true }
        return otherView.isDescendant(of: view)
    }
}
