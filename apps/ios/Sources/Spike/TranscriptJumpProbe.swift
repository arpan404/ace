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
    /// The feed is hidden or frozen: the reader sees none of what moves under it, so those frames
    /// aren't sampled. The first frame shown again is compared with the last one shown before.
    private var covered = false

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

    /// The row's marker went away; another marker may have taken its id since.
    func unregister(_ view: UIView, row id: String) {
        if rows[id]?.view === view || rows[id]?.view == nil { rows[id] = nil }
    }

    /// The feed's scroll phase changed.
    /// A new gesture ends the run: what the reader does next is theirs.
    func scrolling(_ phase: String) {
        let touching = ["t", "n"]
        let started = touching.contains(phase) && !touching.contains(self.phase)
        self.phase = phase
        if started, let run, run.frames > 0 { finish() }
    }

    /// Starts sampling `name` (`open`, `older`): from the first frame rows are shown, for
    /// `span` seconds. A run already going is finished first. `hidden` when the feed starts
    /// hidden, until `covered(false)`.
    func begin(_ name: String, hidden: Bool = false, span: CFTimeInterval = 2.5) {
        finish()
        if hidden { covered = true }
        run = Run(name: name, span: span, until: CACurrentMediaTime() + 20)
        let link = CADisplayLink(target: JumpTicker(), selector: #selector(JumpTicker.tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    /// The feed was hidden or frozen (`true`), or shown again.
    func covered(_ value: Bool) { covered = value }

    fileprivate func tick() {
        guard var run else { return }
        let now = CACurrentMediaTime()
        if covered {
            run.time = now
            self.run = run
            return
        }
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
            run.trace.append("swap\(phase)")
        } else if abs(onScreen) >= 0.5 || abs(inContent) >= 0.5 {
            run.trace.append("\(Int(onScreen.rounded()))/\(Int(inContent.rounded()))\(phase)")
        } else {
            run.trace.append(phase)
        }
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
            guard let view = mark.view else { rows[id] = nil; continue }
            guard let window = view.window else { continue }
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
    func makeUIView(context: Context) -> Mark {
        let view = Mark()
        view.row = id
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        TranscriptJumpProbe.shared.register(view, row: id)
        return view
    }
    func updateUIView(_ view: Mark, context: Context) {
        if view.row != id { TranscriptJumpProbe.shared.unregister(view, row: view.row) }
        view.row = id
        TranscriptJumpProbe.shared.register(view, row: id)
    }
    /// A row scrolled away for good: the probe stops looking for it.
    static func dismantleUIView(_ view: Mark, coordinator: ()) {
        TranscriptJumpProbe.shared.unregister(view, row: view.row)
    }

    final class Mark: UIView {
        var row = ""
    }
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
    /// A page's run lasts longer than an opening's: it spans the fling and the page joining at
    /// its rest.
    @MainActor static func begin(_ name: String, hidden: Bool = false, span: Double = 2.5) {
        #if ACE_FIXTURE
        if PerfProbe.enabled { TranscriptJumpProbe.shared.begin(name, hidden: hidden, span: span) }
        #endif
    }
    /// The feed is frozen over (`true`) or shown again.
    @MainActor static func covered(_ value: Bool) {
        #if ACE_FIXTURE
        if PerfProbe.enabled { TranscriptJumpProbe.shared.covered(value) }
        #endif
    }
    /// A thread's opening was shown `seconds` after its rows were ready; `capped` when it was
    /// still moving at the limit. Recorded as `jump.reveal.ms` and `jump.reveal.capped`.
    @MainActor static func revealed(after seconds: Double, capped: Bool) {
        #if ACE_FIXTURE
        guard PerfProbe.enabled else { return }
        TranscriptJumpProbe.shared.covered(false)
        PerfProbe.record(["jump.reveal.ms": String(Int((seconds * 1_000).rounded())), "jump.reveal.capped": capped ? "1" : "0"])
        #endif
    }
    /// Where the opened feed landed: `fromEnd`, read a few frames after it showed, is how far its
    /// end is below the bottom edge. Recorded as `jump.landed.fromEnd`.
    @MainActor static func landed(fromEnd: @escaping @MainActor () -> Double) {
        #if ACE_FIXTURE
        guard PerfProbe.enabled else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(100))
            PerfProbe.record(["jump.landed.fromEnd": String(Int(fromEnd().rounded()))])
        }
        #endif
    }
    /// DIAG(#2316): an event on the open's timeline, in ms since the feed appeared.
    @MainActor static func mark(_ event: String) {
        #if ACE_FIXTURE
        guard PerfProbe.enabled else { return }
        let now = CACurrentMediaTime()
        if openedAt == 0 || event == "appeared" { openedAt = now; timeline = [] }
        timeline.append("\(Int(((now - openedAt) * 1_000).rounded())):\(event)")
        PerfProbe.record(["jump.timeline": timeline.joined(separator: "|")])
        #endif
    }
    @MainActor private static var openedAt: CFTimeInterval = 0
    @MainActor private static var timeline: [String] = []
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
