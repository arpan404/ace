import SwiftUI
import UIKit

/// The display's own corner radius, so a page pushed aside by the drawer keeps the phone's
/// roundness at its leading edge.
enum DisplayCornerRadius {
    /// Before the window is known, and on iOS 18, which has no way to ask.
    @MainActor static var fallback: CGFloat { AceTheme.Spacing.xxl * 1.5 }
}

/// Reads the display's corner radius from the window it lands in. On iOS 26 a full-window view
/// with container-concentric corners takes exactly the display's radius, which UIKit reports.
struct DisplayCornerReader: UIViewRepresentable {
    @Binding var radius: CGFloat

    func makeUIView(context: Context) -> ReaderView {
        let view = ReaderView()
        view.isUserInteractionEnabled = false
        view.isHidden = true
        view.report = { found in if found != radius { radius = found } }
        return view
    }
    func updateUIView(_ view: ReaderView, context: Context) {
        view.report = { found in if found != radius { radius = found } }
    }

    final class ReaderView: UIView {
        var report: (CGFloat) -> Void = { _ in }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let window, #available(iOS 26, *) else { return }
            let probe = UIView(frame: window.bounds)
            probe.isUserInteractionEnabled = false
            probe.isHidden = true
            probe.cornerConfiguration = .corners(radius: .containerConcentric())
            window.addSubview(probe)
            let found = probe.effectiveRadius(corner: .topLeft)
            probe.removeFromSuperview()
            // Square displays (the simulator's older devices, an external screen) keep the fallback.
            // Reported after this layout pass: state never changes while SwiftUI draws.
            if found > 0 { DispatchQueue.main.async { [report] in report(found) } }
        }
    }
}
