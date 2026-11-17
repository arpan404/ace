import SwiftUI
import UIKit

/// Fixture builds launched with `--perf-probe`: how the transcript's rows move on screen by
/// themselves while a thread opens and while an older page lands. Each frame it reads where every
/// row on screen is drawn (the layers' presentation values) and takes the median move of the rows
/// it saw the frame before. A move nobody made is a jump: while the feed is at rest, any move;
/// while a finger or a fling moves it, a break in that motion, a frame moving more than
/// `smooth` points beyond the frame before. Each run goes to the probe as
/// `jump.<open|older>.frames` (frames sampled), `.moved` (frames that jumped), `.total` and
/// `.max` (points), and `.trace`, one entry per frame (`<on screen>/<within the content><phase>`,
/// or the phase alone when nothing moved), so a UI test can hold the first paint and paging to
/// keeping the reader's line still. Release builds compile it away.
@MainActor final class TranscriptJumpProbe {
    static let shared = TranscriptJumpProbe()
    private var rows: [String: Weak] = [:]
    private weak var scroller: UIScrollView?
    private var link: CADisplayLink?
    private var run: Run?
    /// The feed's scroll phase: `i`dle, `t`racking, `d`ecelerating, `a`nimating, `n` interacting.
    private var phase = "i"
    private var moving: Bool { phase != "i" }
    /// Runs finished, by name, so each page's run is kept apart.
    private var counts: [String: Int] = [:]

    private struct Run {
        let name: String
        /// How long it samples once rows are on screen.
        let span: CFTimeInterval
        var until: CFTimeInterval
        var painted = false
        var last: [String: Double] = [:]
        var offset: Double = 0
        /// The last frame's move on screen, per display frame.
        var step: Double = 0
        var time: CFTimeInterval = 0
        var frames = 0
        var moved = 0
        var total: Double = 0
        var most: Double = 0
        var trace: [String] = []
    }

    func register(_ view: UIView, row id: String) { rows[id] = Weak(view: view) }

    /// The feed scrolled itself (`mark`'s letter): shown on the next frame's trace entry.
    private var marks = ""
    func mark(_ letter: String) { if run != nil { marks += letter } }

    /// The feed's scroll phase changed.
    /// A new gesture ends the run: what the reader does next is theirs.
    func scrolling(_ phase: String) {
        let touching = ["t", "n"]
        let started = touching.contains(phase) && !touching.contains(self.phase)
        self.phase = phase
        if started, let run, run.frames > 0 { finish() }
    }

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
        let frame = link?.duration ?? 1.0 / 60
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
            run.time = now
            return
        }
        run.frames += 1
        let shifts = seen.compactMap { id, y in run.last[id].map { y - $0 } }.sorted()
        // No row stayed on screen from one frame to the next: the whole screen was replaced.
        let onScreen = shifts.isEmpty ? Double.infinity : shifts[shifts.count / 2]
        // Within the content: the move on screen less the scroll's own.
        let inContent = onScreen + (offset - run.offset)
        // A fling slows by a few points a frame, and a finger moves about as evenly. A frame the
        // app dropped carries two frames' motion, so motion is compared per display frame.
        let smooth = 10.0
        let frames = max(1, ((now - run.time) / max(frame, 0.001)).rounded())
        let step = onScreen.isFinite ? onScreen / frames : 0
        let jump = !moving ? onScreen : abs(step - run.step) > smooth ? step - run.step : 0
        if abs(jump) >= 0.5 {
            let size = jump.isFinite ? abs(jump) : 999
            run.moved += 1
            run.total += size
            run.most = max(run.most, size)
        }
        // Each frame: the move on screen, then within the content, then the phase.
        if !onScreen.isFinite {
            run.trace.append("swap\(phase)\(marks)")
        } else if abs(onScreen) >= 0.5 || abs(inContent) >= 0.5 {
            run.trace.append("\(Int(onScreen.rounded()))/\(Int(inContent.rounded()))\(phase)\(marks)")
        } else {
            run.trace.append(phase + marks)
        }
        marks = ""
        run.last = seen
        run.offset = offset
        run.step = step
        run.time = now
    }

    private func finish() {
        link?.invalidate()
        link = nil
        guard let run else { return }
        self.run = nil
        let key = "jump.\(run.name)"
        let count = (counts[run.name] ?? 0) + 1
        counts[run.name] = count
        let values = ["frames": String(run.frames), "moved": String(run.moved), "total": String(Int(run.total.rounded())),
                      "max": String(Int(run.most.rounded())), "trace": run.trace.joined(separator: ",")]
        // The latest run under `jump.<name>`, and each one under `jump.<name>.<n>`.
        var entries: [String: String] = [:]
        for (field, value) in values {
            entries["\(key).\(field)"] = value
            entries["\(key).\(count).\(field)"] = value
        }
        PerfProbe.record(entries)
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
    /// The feed scrolled itself; `letter` names which scroll (`ConversationFeed`).
    @MainActor static func mark(_ letter: String) {
        #if ACE_FIXTURE
        if PerfProbe.enabled { TranscriptJumpProbe.shared.mark(letter) }
        #endif
    }
    @MainActor static func scrolling(_ phase: ScrollPhase) {
        #if ACE_FIXTURE
        guard PerfProbe.enabled else { return }
        let letter: String
        switch phase {
        case .idle: letter = "i"
        case .tracking: letter = "t"
        case .interacting: letter = "n"
        case .decelerating: letter = "d"
        case .animating: letter = "a"
        @unknown default: letter = "?"
        }
        TranscriptJumpProbe.shared.scrolling(letter)
        #endif
    }
}
