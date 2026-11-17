import SwiftUI
import UIKit

/// Fixture builds launched with `--perf-probe`: how the transcript's rows move on screen by
/// themselves while a thread opens and while an older page lands. Each frame it reads where every
/// row on screen is drawn (the layers' presentation values) and takes the median move of the rows
/// it saw the frame before. A move nobody made is a jump: while the feed is at rest, any move;
/// while a finger or a fling moves it, only what the rows moved within the content (the move
/// less the scroll's own). Each run goes to the probe as `jump.<open|older>.frames` (frames
/// sampled), `.moved` (frames that jumped), `.total` and `.max` (points), and `.trace`, one
/// value per frame, so a UI test can hold the first paint and paging to keeping the reader's line
/// still. Release builds compile it away.
@MainActor final class TranscriptJumpProbe {
    static let shared = TranscriptJumpProbe()
    private var rows: [String: Weak] = [:]
    private weak var scroller: UIScrollView?
    private var link: CADisplayLink?
    private var run: Run?
    /// The person or a fling is moving the feed (its scroll phase isn't idle).
    private var moving = false

    private struct Run {
        let name: String
        /// How long it samples once rows are on screen.
        let span: CFTimeInterval
        var until: CFTimeInterval
        var painted = false
        var last: [String: Double] = [:]
        var offset: Double = 0
        var frames = 0
        var moved = 0
        var total: Double = 0
        var most: Double = 0
        var trace: [String] = []
    }

    func register(_ view: UIView, row id: String) { rows[id] = Weak(view: view) }

    /// The feed's scroll phase changed.
    func scrolling(_ moving: Bool) { self.moving = moving }

    /// Starts sampling `name` (`open`, `older`): from the first frame rows are on screen, for
    /// `span` seconds. A run already going is finished first.
    func begin(_ name: String, span: CFTimeInterval = 2.5) {
        finish()
        run = Run(name: name, span: span, until: CACurrentMediaTime() + 20)
        let link = CADisplayLink(target: JumpTicker(), selector: #selector(JumpTicker.tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    fileprivate func tick() {
        guard var run else { return }
        let now = CACurrentMediaTime()
        let seen = visible()
        let offset = Double(scroller?.layer.presentation()?.bounds.minY ?? scroller?.contentOffset.y ?? 0)
        defer {
            self.run = run
            if now >= run.until { finish() }
        }
        guard !seen.isEmpty else { return }
        guard run.painted else {
            run.painted = true
            run.until = now + run.span
            run.last = seen
            run.offset = offset
            return
        }
        run.frames += 1
        let shifts = seen.compactMap { id, y in run.last[id].map { y - $0 } }.sorted()
        // No row stayed on screen from one frame to the next: the whole screen was replaced.
        let onScreen = shifts.isEmpty ? Double.infinity : shifts[shifts.count / 2]
        // Within the content: the move on screen less the scroll's own.
        let inContent = onScreen + (offset - run.offset)
        let jump = moving ? inContent : onScreen
        if abs(jump) >= 0.5 {
            let size = jump.isFinite ? abs(jump) : 999
            run.moved += 1
            run.total += size
            run.most = max(run.most, size)
            run.trace.append(jump.isFinite ? String(Int(jump.rounded())) : "swap")
        } else {
            run.trace.append(moving ? "m" : "0")
        }
        run.last = seen
        run.offset = offset
    }

    private func finish() {
        link?.invalidate()
        link = nil
        guard let run else { return }
        self.run = nil
        let key = "jump.\(run.name)"
        PerfProbe.record(["\(key).frames": String(run.frames), "\(key).moved": String(run.moved),
                          "\(key).total": String(Int(run.total.rounded())), "\(key).max": String(Int(run.most.rounded())),
                          "\(key).trace": run.trace.joined(separator: ",")])
        PerfProbe.add("\(key).runs", 1)
        PerfProbe.add("\(key).movedAll", Double(run.moved))
    }

    /// Where each row on screen is drawn this frame: its top, in window points.
    private func visible() -> [String: Double] {
        var seen: [String: Double] = [:]
        for (id, mark) in rows {
            guard let view = mark.view, let window = view.window else { continue }
            if scroller == nil { scroller = Self.scrollView(above: view) }
            let layer = view.layer.presentation() ?? view.layer
            let top = Double(layer.convert(CGPoint.zero, to: nil).y)
            let bottom = top + Double(layer.bounds.height)
            if bottom > 0, top < Double(window.bounds.height) { seen[id] = top }
        }
        return seen
    }

    private static func scrollView(above view: UIView) -> UIScrollView? {
        var next = view.superview
        while let current = next {
            if let scroll = current as? UIScrollView { return scroll }
            next = current.superview
        }
        return nil
    }

    private struct Weak { weak var view: UIView? }
}

/// The display link's target: a link holds its target strongly, so the probe isn't it.
private final class JumpTicker: NSObject {
    @MainActor @objc func tick() { TranscriptJumpProbe.shared.tick() }
}

/// A view as large as the row it marks, which the probe reads.
private struct JumpMarkView: UIViewRepresentable {
    let id: String
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        TranscriptJumpProbe.shared.register(view, row: id)
        return view
    }
    func updateUIView(_ view: UIView, context: Context) { TranscriptJumpProbe.shared.register(view, row: id) }
}

extension View {
    /// Marks a transcript row for `TranscriptJumpProbe`; nothing outside probed fixture builds.
    @ViewBuilder func transcriptJumpMark(_ id: String) -> some View {
        #if ACE_FIXTURE
        if PerfProbe.enabled {
            background { JumpMarkView(id: id).allowsHitTesting(false).accessibilityHidden(true) }
        } else {
            self
        }
        #else
        self
        #endif
    }
}

/// Probe hooks the feed calls; nothing outside probed fixture builds.
enum TranscriptJumpHooks {
    @MainActor static func begin(_ name: String) {
        #if ACE_FIXTURE
        if PerfProbe.enabled { TranscriptJumpProbe.shared.begin(name) }
        #endif
    }
    @MainActor static func scrolling(_ moving: Bool) {
        #if ACE_FIXTURE
        if PerfProbe.enabled { TranscriptJumpProbe.shared.scrolling(moving) }
        #endif
    }
}
