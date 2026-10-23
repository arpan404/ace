import SwiftUI
import UIKit

/// A light sweep across live text. Off with Reduce Motion, where the text simply stays put. The
/// sweep moves in Core Animation: a SwiftUI timeline would update the view graph 30 times a
/// second for as long as the text is live.
struct Shimmer: ViewModifier {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        if active && !reduceMotion {
            content.overlay {
                ShimmerSweep(colour: UIColor(AceTheme.Colours.foreground), period: AceTheme.Motion.statusPulse)
                    .mask(content)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        } else {
            content
        }
    }
}

/// A band half as wide as the view, clear at both edges and `colour` in the middle, crossing from
/// half a band before the leading edge to the trailing edge once every `period`, at an even pace.
/// Every sweep keeps the same phase, taken from the clock, so live rows shimmer together.
private struct ShimmerSweep: UIViewRepresentable {
    let colour: UIColor
    let period: Double
    func makeUIView(context: Context) -> SweepView { SweepView() }
    func updateUIView(_ view: SweepView, context: Context) {
        view.colour = colour
        view.period = period
    }

    final class SweepView: UIView {
        private let band = CAGradientLayer()
        private var laidOut = CGSize.zero
        var colour = UIColor.clear { didSet { if colour != oldValue { paint() } } }
        var period = 1.6 { didSet { if period != oldValue { restart() } } }

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            band.startPoint = CGPoint(x: 0, y: 0.5)
            band.endPoint = CGPoint(x: 1, y: 0.5)
            layer.addSublayer(band)
            registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: SweepView, _: UITraitCollection) in view.paint() }
        }
        required init?(coder: NSCoder) { nil }

        override func layoutSubviews() {
            super.layoutSubviews()
            guard bounds.size != laidOut else { return }
            laidOut = bounds.size
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            band.bounds = CGRect(x: 0, y: 0, width: bounds.width * 0.5, height: bounds.height)
            band.position = CGPoint(x: -bounds.width * 0.25, y: bounds.midY)
            CATransaction.commit()
            restart()
        }
        // A layer leaving the window loses its animations; a row shown again sweeps again.
        override func didMoveToWindow() {
            super.didMoveToWindow()
            restart()
        }

        private func paint() {
            let resolved = colour.resolvedColor(with: traitCollection)
            band.colors = [resolved.withAlphaComponent(0).cgColor, resolved.cgColor, resolved.withAlphaComponent(0).cgColor]
        }
        private func restart() {
            band.removeAnimation(forKey: "sweep")
            guard window != nil, bounds.width > 0, period > 0 else { return }
            let sweep = CABasicAnimation(keyPath: "position.x")
            sweep.fromValue = -bounds.width * 0.25
            sweep.toValue = bounds.width * 1.25
            sweep.duration = period
            sweep.repeatCount = .infinity
            sweep.timeOffset = Date().timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period)
            band.add(sweep, forKey: "sweep")
        }
    }
}
