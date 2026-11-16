import SwiftUI
import UIKit

/// Fixture builds launched with `--perf-probe`: while the keyboard moves, where the transcript's
/// last line, the composer's top edge and the system's keyboard edge are drawn, read every frame
/// from the layers' presentation values. Each motion goes to the probe as
/// `keyboard.<open|close>.gaps` (composer top minus last line, one rounded value per frame),
/// `keyboard.<open|close>.drift` (the widest gap minus the narrowest) and
/// `keyboard.<open|close>.lag` (the farthest the composer's foot was from the keyboard's edge),
/// so a UI test can hold the line and the composer to moving as one (#2170).
/// Release builds compile it away.
@MainActor final class KeyboardDriftProbe {
    static let shared = KeyboardDriftProbe()
    /// `line` and `composer` mark their view's top edge; `composerFoot` and `keyboard` its bottom.
    enum Mark { case line, composer, composerFoot, keyboard }
    private var marks: [Mark: Weak] = [:]
    private var link: CADisplayLink?
    private var gaps: [Double] = []
    /// Each frame's drawn y of the line, the composer's top and the keyboard's edge.
    private var trace: [String] = []
    private var lag: Double = 0
    private var until: CFTimeInterval = 0
    private var motion = "open"
    private var observing = false

    func register(_ view: UIView, as mark: Mark) {
        marks[mark] = Weak(view: view)
        guard !observing else { return }
        observing = true
        NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { note in
            let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
            let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
            let curve = note.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? Int ?? -1
            MainActor.assumeIsolated {
                KeyboardDriftProbe.shared.began(end: end, duration: duration)
                PerfProbe.record(["keyboard.note": "\(duration)s curve \(curve) end \(end.debugDescription)"])
            }
        }
    }

    private func began(end: CGRect?, duration: Double) {
        guard let end, let window = marks[.line]?.view?.window ?? marks[.composer]?.view?.window else { return }
        let motion = end.minY >= window.bounds.maxY - 1 ? "close" : "open"
        let until = CACurrentMediaTime() + max(duration, 0.25) + 0.3
        // The keyboard can move twice for one opening (its suggestions bar): one run for both.
        if link != nil, motion == self.motion {
            self.until = until
            return
        }
        finish()
        self.motion = motion
        self.until = until
        gaps = []
        trace = []
        lag = 0
        // The frame before the motion, then every frame until it has surely settled.
        sample()
        let link = CADisplayLink(target: Ticker(), selector: #selector(Ticker.tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    fileprivate func tick() {
        sample()
        if CACurrentMediaTime() >= until { finish() }
    }

    private func sample() {
        if let line = y(.line), let composer = y(.composer) { gaps.append((composer - line).rounded()) }
        if let foot = y(.composerFoot), let keyboard = y(.keyboard) { lag = max(lag, abs(keyboard - foot).rounded()) }
        trace.append([Mark.line, .composer, .keyboard].map { y($0).map { String(Int($0.rounded())) } ?? "-" }.joined(separator: "/"))
    }

    private func finish() {
        guard let link else { return }
        link.invalidate()
        self.link = nil
        guard let low = gaps.min(), let high = gaps.max() else { return }
        PerfProbe.record(["keyboard.\(motion).gaps": gaps.map { String(Int($0)) }.joined(separator: ","),
                          "keyboard.\(motion).drift": String(Int(high - low)),
                          "keyboard.\(motion).lag": String(Int(lag)),
                          "keyboard.\(motion).trace": trace.joined(separator: " ")])
    }

    /// Where `mark`'s edge is drawn on screen this frame, mid-animation included.
    private func y(_ mark: Mark) -> Double? {
        guard let view = marks[mark]?.view, view.window != nil else { return nil }
        let layer = view.layer.presentation() ?? view.layer
        let bottom = mark == .composerFoot || mark == .keyboard
        return Double(layer.convert(CGPoint(x: 0, y: bottom ? layer.bounds.height : 0), to: nil).y)
    }

    private struct Weak { weak var view: UIView? }
}

/// The display link's target: a link holds its target strongly, so the probe isn't it.
private final class Ticker: NSObject {
    @MainActor @objc func tick() { KeyboardDriftProbe.shared.tick() }
}

/// A view as large as what it marks, which the probe reads.
private struct DriftMarkView: UIViewRepresentable {
    let mark: KeyboardDriftProbe.Mark
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        KeyboardDriftProbe.shared.register(view, as: mark)
        return view
    }
    func updateUIView(_ view: UIView, context: Context) {}
}

extension View {
    /// Marks this view's edge for `KeyboardDriftProbe`; nothing outside probed fixture builds.
    @ViewBuilder func keyboardDriftMark(_ mark: KeyboardDriftProbe.Mark) -> some View {
        #if ACE_FIXTURE
        if PerfProbe.enabled {
            background { DriftMarkView(mark: mark).allowsHitTesting(false).accessibilityHidden(true) }
        } else {
            self
        }
        #else
        self
        #endif
    }
}

/// Fills the space the system's keyboard avoidance leaves, so its bottom edge is the keyboard's
/// top on every frame, on the system's own curve. Nothing outside probed fixture builds.
struct KeyboardEdgeMark: View {
    var body: some View {
        #if ACE_FIXTURE
        if PerfProbe.enabled {
            Color.clear.keyboardDriftMark(.keyboard).allowsHitTesting(false).accessibilityHidden(true)
        }
        #endif
    }
}
