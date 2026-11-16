import SwiftUI
import UIKit

/// Where the docked keyboard's top edge is drawn, frame by frame (#2170). A one-point view is
/// pinned to its container's `keyboardLayoutGuide`, so UIKit animates it with the keyboard, on the
/// keyboard's own animation. Reading that animation at a frame's display time gives where the
/// keyboard is drawn on that frame; the presentation layer only says where it is now, a frame
/// behind what the next frame shows.
@MainActor final class KeyboardEdgeTracker {
    /// How a reading was made: from the keyboard's animation at the asked time, or from the
    /// presentation layer at the current time when the animation couldn't be read.
    enum Source: String { case animation, presentation }

    struct Reading {
        /// The keyboard's top edge, in window points.
        let y: CGFloat
        let source: Source
        /// Whether an animation was still moving the edge.
        let moving: Bool
    }

    fileprivate weak var edge: UIView?

    /// Where the keyboard's edge is drawn on the frame shown at `time` (`CACurrentMediaTime`
    /// clock); nil while there is no edge in a window to read.
    func reading(at time: CFTimeInterval) -> Reading? {
        guard let edge, let window = edge.window, let container = edge.superview else { return nil }
        let layer = edge.layer
        let animations = (layer.animationKeys() ?? [])
            .compactMap { layer.animation(forKey: $0) as? CABasicAnimation }
            .filter { $0.keyPath == "position" || $0.keyPath == "position.y" }
        var y = Double(layer.position.y)
        var source = Source.animation
        if !animations.isEmpty {
            // Core Animation applies them in the order added: an additive one moves the value
            // so far, any other replaces it.
            for animation in animations {
                guard let value = Self.value(of: animation, in: layer, at: time) else {
                    y = Double(layer.presentation()?.position.y ?? layer.position.y)
                    source = .presentation
                    break
                }
                y = animation.isAdditive ? y + value : value
            }
        }
        let top = CGFloat(y) - layer.bounds.height * layer.anchorPoint.y
        let inWindow = container.convert(CGPoint(x: 0, y: top), to: window)
        return Reading(y: inWindow.y, source: source, moving: !animations.isEmpty)
    }

    /// `animation`'s value for the edge's y at `time`; nil for a kind of animation this can't read.
    private static func value(of animation: CABasicAnimation, in layer: CALayer, at time: CFTimeInterval) -> Double? {
        guard let from = coordinate(animation.fromValue, keyPath: animation.keyPath) else { return nil }
        let to = coordinate(animation.toValue, keyPath: animation.keyPath) ?? (animation.isAdditive ? 0 : Double(layer.position.y))
        let local = layer.convertTime(time, from: nil)
        let elapsed = (local - animation.beginTime) * Double(animation.speed) + animation.timeOffset
        let fraction: Double
        if elapsed >= animation.duration {
            fraction = 1
        } else if let spring = animation as? CASpringAnimation {
            fraction = AnimationTiming.spring(mass: Double(spring.mass), stiffness: Double(spring.stiffness),
                                              damping: Double(spring.damping), initialVelocity: Double(spring.initialVelocity),
                                              elapsed: elapsed)
        } else {
            let timing = animation.timingFunction ?? CAMediaTimingFunction(name: .linear)
            var first: [Float] = [0, 0], second: [Float] = [0, 0]
            timing.getControlPoint(at: 1, values: &first)
            timing.getControlPoint(at: 2, values: &second)
            fraction = AnimationTiming.bezier(x1: Double(first[0]), y1: Double(first[1]), x2: Double(second[0]), y2: Double(second[1]),
                                              at: elapsed / max(animation.duration, 0.001))
        }
        return from + (to - from) * fraction
    }

    /// The y in an animation's from or to value, for a position or position.y animation.
    private static func coordinate(_ value: Any?, keyPath: String?) -> Double? {
        if keyPath == "position.y" { return (value as? NSNumber)?.doubleValue }
        return (value as? NSValue).map { Double($0.cgPointValue.y) }
    }
}

/// The view UIKit moves with the keyboard: a one-point edge pinned to the keyboard layout guide's
/// top, in a container pinned to the window's own edges. The guide measures the keyboard up from
/// its view's bottom, so a container placed by SwiftUI, which can hang past the screen, put the
/// edge 116 pt off. Draws nothing and takes no touches.
struct KeyboardEdgeReader: UIViewRepresentable {
    let tracker: KeyboardEdgeTracker

    func makeUIView(context: Context) -> KeyboardEdgeHost {
        let host = KeyboardEdgeHost()
        tracker.edge = host.edge
        #if ACE_FIXTURE
        if PerfProbe.enabled { KeyboardDriftProbe.shared.register(host.edge, as: .keyboard) }
        #endif
        return host
    }

    func updateUIView(_ view: KeyboardEdgeHost, context: Context) {}
}

/// Holds the window-sized container for `KeyboardEdgeReader`, pinning it to whichever window it
/// joins. A view may be constrained to any of its ancestors, the window included.
final class KeyboardEdgeHost: UIView {
    let edge = UIView()
    private let container = UIView()
    private var pins: [NSLayoutConstraint] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        container.translatesAutoresizingMaskIntoConstraints = false
        container.isUserInteractionEnabled = false
        edge.translatesAutoresizingMaskIntoConstraints = false
        edge.isUserInteractionEnabled = false
        addSubview(container)
        container.addSubview(edge)
        NSLayoutConstraint.activate([
            edge.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            edge.widthAnchor.constraint(equalToConstant: 1),
            edge.heightAnchor.constraint(equalToConstant: 1),
            edge.topAnchor.constraint(equalTo: container.keyboardLayoutGuide.topAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        NSLayoutConstraint.deactivate(pins)
        pins = []
        guard let window else { return }
        pins = [
            container.topAnchor.constraint(equalTo: window.topAnchor),
            container.bottomAnchor.constraint(equalTo: window.bottomAnchor),
            container.leadingAnchor.constraint(equalTo: window.leadingAnchor),
            container.trailingAnchor.constraint(equalTo: window.trailingAnchor),
        ]
        NSLayoutConstraint.activate(pins)
    }
}
