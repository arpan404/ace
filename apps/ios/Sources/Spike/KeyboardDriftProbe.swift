import SwiftUI
import UIKit

/// Fixture builds launched with `--perf-probe`: while the keyboard moves, the on-screen gap
/// between the transcript's last line and the composer's top edge, read every frame from what is
/// drawn (the layers' presentation values). Each motion goes to the probe as
/// `keyboard.<open|close>.gaps` (one rounded gap per frame) and `keyboard.<open|close>.drift`
/// (the widest minus the narrowest gap), so a UI test can hold the two to moving as one (#2170).
/// Release builds compile it away.
@MainActor final class KeyboardDriftProbe {
    static let shared = KeyboardDriftProbe()
    enum Mark { case line, composer }
    private weak var line: UIView?
    private weak var composer: UIView?
    private var link: CADisplayLink?
    private var gaps: [Double] = []
    private var until: CFTimeInterval = 0
    private var motion = "open"
    private var observing = false

    func register(_ view: UIView, as mark: Mark) {
        switch mark {
        case .line: line = view
        case .composer: composer = view
        }
        guard !observing else { return }
        observing = true
        NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { note in
            let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
            let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
            MainActor.assumeIsolated { KeyboardDriftProbe.shared.began(end: end, duration: duration) }
        }
    }

    private func began(end: CGRect?, duration: Double) {
        guard let end, let window = line?.window ?? composer?.window else { return }
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
        guard let line = line.flatMap(Self.screenY), let composer = composer.flatMap(Self.screenY) else { return }
        gaps.append((composer - line).rounded())
    }

    private func finish() {
        guard let link else { return }
        link.invalidate()
        self.link = nil
        guard let low = gaps.min(), let high = gaps.max() else { return }
        PerfProbe.record(["keyboard.\(motion).gaps": gaps.map { String(Int($0)) }.joined(separator: ","),
                          "keyboard.\(motion).drift": String(Int(high - low))])
    }

    /// Where `view`'s top edge is drawn on screen this frame, mid-animation included.
    private static func screenY(_ view: UIView) -> Double? {
        guard view.window != nil else { return nil }
        let layer = view.layer.presentation() ?? view.layer
        return Double(layer.convert(CGPoint.zero, to: nil).y)
    }
}

/// The display link's target: a link holds its target strongly, so the probe isn't it.
private final class Ticker: NSObject {
    @MainActor @objc func tick() { KeyboardDriftProbe.shared.tick() }
}

/// A one-point view at the top edge of what it marks, which the probe reads.
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
    /// Marks this view's top edge for `KeyboardDriftProbe`; nothing outside probed fixture builds.
    @ViewBuilder func keyboardDriftMark(_ mark: KeyboardDriftProbe.Mark) -> some View {
        #if ACE_FIXTURE
        if PerfProbe.enabled {
            background(alignment: .top) { DriftMarkView(mark: mark).frame(height: 1).allowsHitTesting(false).accessibilityHidden(true) }
        } else {
            self
        }
        #else
        self
        #endif
    }
}
