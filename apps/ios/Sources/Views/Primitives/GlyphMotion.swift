import SwiftUI
import UIKit

/// A moving status glyph drawn and moved by Core Animation, so its motion runs in the render
/// server and costs the main thread nothing per frame. The same parts and timing as the still
/// glyph's SwiftUI drawing: working's two arcs swing 28° apart and back every 0.9 s, subagents'
/// three arcs turn a third every 0.9 s, background's dot slides out and fades every 1.6 s.
struct GlyphMotion: UIViewRepresentable {
    let state: GlyphState
    let colour: UIColor
    func makeUIView(context: Context) -> MotionView { MotionView() }
    func updateUIView(_ view: MotionView, context: Context) { view.show(state, colour: colour) }

    final class MotionView: UIView {
        /// One layer per moving part: its paths, whether they're filled rather than stroked, and
        /// its motion over the glyph's size.
        private struct Part {
            let layer = CAShapeLayer()
            let paths: [GlyphPath]
            let filled: Bool
            let motion: ((CGFloat) -> CAAnimation)?
        }
        private var state: GlyphState?
        private var colour = UIColor.clear
        private var parts: [Part] = []
        private var laidOut = CGSize.zero

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: MotionView, _: UITraitCollection) in view.paint() }
        }
        required init?(coder: NSCoder) { nil }

        func show(_ state: GlyphState, colour: UIColor) {
            self.colour = colour
            if state != self.state {
                self.state = state
                parts.forEach { $0.layer.removeFromSuperlayer() }
                parts = Self.parts(for: state)
                parts.forEach { layer.addSublayer($0.layer) }
                laidOut = .zero
                setNeedsLayout()
            }
            paint()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            guard bounds.size != laidOut else { return }
            laidOut = bounds.size
            let unit = min(bounds.width, bounds.height) / 16
            for part in parts {
                part.layer.frame = bounds
                let path = CGMutablePath()
                part.paths.forEach { path.addPath($0.path(in: bounds).cgPath) }
                part.layer.path = path
                part.layer.lineWidth = part.filled ? 0 : 1.5 * unit
                part.layer.lineCap = .round
                part.layer.lineJoin = .round
            }
            paint()
            restart()
        }
        // A layer leaving the window loses its animations; a glyph shown again moves again.
        override func didMoveToWindow() {
            super.didMoveToWindow()
            restart()
        }

        private func paint() {
            let resolved = colour.resolvedColor(with: traitCollection).cgColor
            for part in parts {
                part.layer.fillColor = part.filled ? resolved : nil
                part.layer.strokeColor = part.filled ? nil : resolved
            }
        }
        private func restart() {
            for part in parts {
                part.layer.removeAnimation(forKey: "motion")
                guard window != nil, let motion = part.motion, bounds.width > 0 else { continue }
                part.layer.add(motion(bounds.width), forKey: "motion")
            }
        }

        private static func parts(for state: GlyphState) -> [Part] {
            switch state {
            case .working:
                [Part(paths: [.arc(from: 300, to: 420)], filled: false, motion: { _ in turn(by: 28, every: 0.9, back: true) }),
                 Part(paths: [.arc(from: 120, to: 240)], filled: false, motion: { _ in turn(by: -28, every: 0.9, back: true) })]
            case .subagents:
                [Part(paths: [.arc(from: 20, to: 100), .arc(from: 140, to: 220), .arc(from: 260, to: 340)], filled: false,
                      motion: { _ in turn(by: 120, every: 0.9, back: false) })]
            case .background:
                [Part(paths: [.arc(from: 130, to: 410)], filled: false, motion: nil),
                 Part(paths: [.dot(1.6)], filled: true, motion: { size in
                     let slide = CABasicAnimation(keyPath: "transform.translation.x")
                     slide.fromValue = 0
                     slide.toValue = size * 0.4
                     let fade = CABasicAnimation(keyPath: "opacity")
                     fade.fromValue = 1
                     fade.toValue = 0
                     return repeating(group(slide, fade), every: 1.6, back: false)
                 })]
            default: []
            }
        }
        private static func turn(by degrees: Double, every duration: Double, back: Bool) -> CAAnimation {
            let turn = CABasicAnimation(keyPath: "transform.rotation.z")
            turn.fromValue = 0
            turn.toValue = degrees * .pi / 180
            return repeating(turn, every: duration, back: back)
        }
        private static func group(_ animations: CAAnimation...) -> CAAnimation {
            let group = CAAnimationGroup()
            group.animations = animations
            return group
        }
        /// SwiftUI's `.easeInOut(duration:).repeatForever(autoreverses:)`, as Core Animation runs it.
        private static func repeating(_ animation: CAAnimation, every duration: Double, back: Bool) -> CAAnimation {
            animation.duration = duration
            // A group's parts run its whole length, linearly in its eased time.
            (animation as? CAAnimationGroup)?.animations?.forEach { $0.duration = duration }
            animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            animation.autoreverses = back
            animation.repeatCount = .infinity
            return animation
        }
    }
}
