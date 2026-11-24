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
    /// What waits for the feed to settle. Each runs on its own: an older page landing while a
    /// thread's opening is still hidden doesn't cancel the reveal.
    ///
    /// A reveal doesn't settle while a page's hold is still placing its row: the feed would show
    /// mid-correction. It still shows at its limit if the hold outlasts it.
    enum Run: Hashable, Sendable, CaseIterable {
        // The order each frame asks them in: a hold ending this frame lets the reveal settle in it.
        case page, reveal
    }

    private weak var scroller: UIScrollView?
    private var link: CADisplayLink?
    private var runs: [Run: (settle: (CFTimeInterval) -> TranscriptSettle.Outcome, done: (TranscriptSettle.Outcome) -> Void)] = [:]
    private var frozen: UIView?

    /// Scroll offset in chronological coordinates, measured from the live edge.
    var offset: Double { -Double(scroller?.contentOffset.y ?? 0) }
    /// A frozen frame is laid over the feed (`freeze`).
    var isFrozen: Bool { frozen != nil }
    /// The scroll view under the rows has been found: `shift` moves it.
    var attached: Bool { scroller != nil }

    private var locate: ((String) -> CGRect?)?
    private var animating: (() -> Void)?

    /// The transcript's collection view: `locate` gives an entry's physical frame, `animating`
    /// is told before an animated scroll starts.
    func attach(_ scroller: UIScrollView, locate: @escaping (String) -> CGRect?, animating: @escaping () -> Void) {
        self.scroller = scroller
        self.locate = locate
        self.animating = animating
    }

    /// Where the layout places the entry `id` now, in the feed's screen coordinates
    /// (`TranscriptScrollAxis`): on screen or not, measured or estimated. Nil when the layout
    /// doesn't hold it or the scroll view isn't attached.
    func screenFrame(of id: String) -> CGRect? {
        guard let scroller, let physical = locate?(id) else { return nil }
        let origin = TranscriptScrollAxis.origin(offset: scroller.contentOffset.y, viewport: scroller.bounds.height)
        return TranscriptScrollAxis.row(physical).offsetBy(dx: 0, dy: origin)
    }

    /// Calls `settle` with each drawn frame's time until it says the feed has settled, then
    /// `done`. The same `run` already going ends first, without its `done`; the other run is
    /// left alone.
    func untilSettled(_ run: Run, _ settle: @escaping (CFTimeInterval) -> TranscriptSettle.Outcome,
                      done: @escaping (TranscriptSettle.Outcome) -> Void) {
        runs[run] = (settle, done)
        guard link == nil else { return }
        let link = CADisplayLink(target: SurfaceTicker(surface: self), selector: #selector(SurfaceTicker.tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    /// Whether `run` is still waiting for the feed to settle.
    func running(_ run: Run) -> Bool { runs[run] != nil }

    /// One drawn frame at `time`: each run waiting is asked whether the feed has settled. The
    /// display link calls it.
    func drawn(at time: CFTimeInterval) {
        for run in Run.allCases {
            guard let (settle, done) = runs[run] else { continue }
            var outcome = settle(time)
            if run == .reveal, outcome == .settled, running(.page) { outcome = .waiting }
            guard outcome != .waiting else { continue }
            runs[run] = nil
            done(outcome)
        }
        if runs.isEmpty { stopLink() }
    }

    /// Ends `run` without its `done`.
    func stop(_ run: Run) {
        runs[run] = nil
        if runs.isEmpty { stopLink() }
    }

    /// Ends every run without their `done`: the feed went away.
    func stopAll() {
        runs = [:]
        stopLink()
    }

    private func stopLink() {
        link?.invalidate()
        link = nil
    }

    /// Freezes what is drawn now over the feed, under the header and the composer. False when
    /// there is no drawn feed to freeze.
    func freeze() -> Bool {
        // A still frame over a feed under a finger or a fling would hide it moving.
        guard frozen == nil, let scroller, !scroller.isDragging, !scroller.isDecelerating,
              let parent = scroller.superview, scroller.window != nil,
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

    /// Scrolls so `anchor` of the entry `id` meets the same point of the viewport, both in the
    /// scroll view's physical coordinates: `.top` is the live end's side.
    func scroll(to id: String, anchor: UnitPoint, animated: Bool = false) {
        PerfCounters.bump("offset.proxy")
        guard let scroller, let frame = locate?(id) else { return }
        if TranscriptFlingProbe.isolated, scroller.isDragging || scroller.isDecelerating {
            PerfCounters.bump("offset.blocked")
            return
        }
        let viewport = scroller.bounds.height
        let lowest = -scroller.adjustedContentInset.top
        let highest = max(lowest, scroller.contentSize.height + scroller.adjustedContentInset.bottom - viewport)
        let target = min(max(frame.minY + anchor.y * (frame.height - viewport), lowest), highest)
        guard abs(target - scroller.contentOffset.y) >= 0.5 else { return }
        PerfCounters.bump("offset.write")
        if animated { animating?() }
        scroller.setContentOffset(CGPoint(x: scroller.contentOffset.x, y: target), animated: animated)
    }

    /// Moves the content `delta` points up the screen (down, when negative), within its scroll.
    /// Returns how far it moved: less than `delta` at either end of the content.
    @discardableResult func shift(by delta: Double) -> Double {
        guard let scroller else { return 0 }
        let lowest = -scroller.adjustedContentInset.top
        let highest = max(lowest, scroller.contentSize.height + scroller.adjustedContentInset.bottom - scroller.bounds.height)
        let was = scroller.contentOffset.y
        let target = min(max(was - CGFloat(delta), lowest), highest)
        guard target != was else { return 0 }
        guard !scroller.isTracking, !scroller.isDragging, !scroller.isDecelerating else {
            PerfCounters.bump("offset.blocked")
            return 0
        }
        PerfCounters.bump("offset.write")
        scroller.setContentOffset(CGPoint(x: scroller.contentOffset.x, y: target), animated: false)
        return Double(was - target)
    }
}

/// The display link's target: a link holds its target strongly, so the surface isn't it.
@MainActor private final class SurfaceTicker: NSObject {
    weak var surface: TranscriptSurface?
    init(surface: TranscriptSurface) { self.surface = surface }
    @objc func tick(_ link: CADisplayLink) {
        guard let surface else { link.invalidate(); return }
        surface.drawn(at: link.timestamp)
    }
}
