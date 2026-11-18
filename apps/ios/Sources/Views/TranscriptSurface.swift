import SwiftUI
import UIKit

/// The UIKit side of the transcript's scroll view, for the two changes it would otherwise draw in
/// steps (`TranscriptSettle`):
///
/// - **A thread opening.** The feed stays hidden until its rows have measured and its scroll has
///   reached where it opens, then shows there in one frame.
/// - **An older page landing.** The last drawn frame is frozen over the feed while the page's rows
///   join and measure above the reader's line. Each frame, the row that was on top is put back at
///   its drawn height on screen from its measured frame, not from estimates; then the frame thaws.
///
/// A thin shell: it reads and moves the scroll view and ticks with the display; what holds still
/// is the feed's to say, through the closures it passes.
@MainActor final class TranscriptSurface {
    private weak var scroller: UIScrollView?
    private var link: CADisplayLink?
    private var tick: ((CFTimeInterval) -> Bool)?
    private var frozen: UIView?

    /// The scroll view's offset from its content's top, in points.
    var offset: Double { Double(scroller?.contentOffset.y ?? 0) }
    /// An older page's hold is running.
    var holding: Bool { frozen != nil }

    fileprivate func attach(_ view: UIView) {
        var next = view.superview
        while let current = next {
            if let scroll = current as? UIScrollView { scroller = scroll; return }
            next = current.superview
        }
    }

    /// Calls `settle` with each drawn frame's time until it says the feed has settled, then
    /// `done`. A run already going ends first, without its `done`.
    func untilSettled(_ settle: @escaping (CFTimeInterval) -> TranscriptSettle.Outcome,
                      done: @escaping (TranscriptSettle.Outcome) -> Void) {
        stop()
        tick = { time in
            let outcome = settle(time)
            if outcome == .waiting { return true }
            done(outcome)
            return false
        }
        let link = CADisplayLink(target: SurfaceTicker(surface: self), selector: #selector(SurfaceTicker.tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    fileprivate func ticked(_ time: CFTimeInterval) {
        guard let tick, tick(time) else { stop(); return }
    }

    func stop() {
        link?.invalidate()
        link = nil
        tick = nil
    }

    /// Freezes what is drawn now over the feed, under the header and the composer. False when
    /// there is no drawn feed to freeze.
    func freeze() -> Bool {
        guard frozen == nil, let scroller, let parent = scroller.superview, scroller.window != nil,
              let still = scroller.snapshotView(afterScreenUpdates: false) else { return false }
        still.frame = scroller.frame
        still.isUserInteractionEnabled = false
        parent.insertSubview(still, aboveSubview: scroller)
        frozen = still
        return true
    }

    func thaw() {
        frozen?.removeFromSuperview()
        frozen = nil
    }

    /// Moves the content `delta` points up the screen (down, when negative), within its scroll.
    func shift(by delta: Double) {
        guard let scroller else { return }
        let lowest = -scroller.adjustedContentInset.top
        let highest = max(lowest, scroller.contentSize.height + scroller.adjustedContentInset.bottom - scroller.bounds.height)
        let target = min(max(scroller.contentOffset.y + CGFloat(delta), lowest), highest)
        scroller.setContentOffset(CGPoint(x: scroller.contentOffset.x, y: target), animated: false)
    }
}

/// The display link's target: a link holds its target strongly, so the surface isn't it.
@MainActor private final class SurfaceTicker: NSObject {
    weak var surface: TranscriptSurface?
    init(surface: TranscriptSurface) { self.surface = surface }
    @objc func tick(_ link: CADisplayLink) {
        guard let surface else { link.invalidate(); return }
        surface.ticked(link.timestamp)
    }
}

/// Finds the scroll view around the transcript's content for `TranscriptSurface`.
struct TranscriptSurfaceReader: UIViewRepresentable {
    let surface: TranscriptSurface
    func makeUIView(context: Context) -> ReaderView {
        let view = ReaderView()
        view.surface = surface
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        return view
    }
    func updateUIView(_ view: ReaderView, context: Context) { view.surface = surface }

    final class ReaderView: UIView {
        weak var surface: TranscriptSurface?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil { surface?.attach(self) }
        }
    }
}
