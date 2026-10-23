import Foundation
import QuartzCore

/// Display-link gaps while a thread is on screen, logged every five seconds that had motion:
/// frames, late frames (more than one and a half intervals), time lost to them and the worst gap.
/// Measurement only; on the simulator these are callback gaps, not GPU presentation. Runs with
/// `-ace-frame-trace` or the performance probe, never otherwise.
@MainActor final class FrameSampler: NSObject {
    nonisolated static let enabled = PerfProbe.enabled || ProcessInfo.processInfo.arguments.contains("-ace-frame-trace")
    private var link: CADisplayLink?
    private var last: CFTimeInterval?
    private var started = CACurrentMediaTime()
    private var frames = 0, late = 0
    private var lost = 0.0, worst = 0.0

    func run(_ on: Bool) {
        guard on != (link != nil) else { return }
        if on {
            let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
            reset(at: CACurrentMediaTime())
        } else {
            report(at: CACurrentMediaTime())
            link?.invalidate(); link = nil; last = nil
        }
    }
    @objc private func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        let interval = max(link.targetTimestamp - link.timestamp, 1.0 / 120)
        if let last {
            let gap = now - last
            frames += 1
            if gap > interval * 1.5 { late += 1; lost += gap - interval }
            worst = max(worst, gap)
        }
        last = now
        if now - started >= 5 { report(at: now) }
    }
    private func report(at now: CFTimeInterval) {
        if late > 0 || frames > 0 {
            let seconds = now - started
            PerfProbe.record(["frames.late": "\(late)", "frames.hitchMsPerS": String(format: "%.1f", lost * 1000 / max(seconds, 0.001)),
                              "frames.worstMs": String(format: "%.0f", worst * 1000)])
            PerfProbe.add("frames.windows", 1)
            ThreadOpenTrace.log.notice("""
                frames window=\(String(format: "%.1f", seconds), privacy: .public)s frames=\(self.frames) late=\(self.late) \
                lostMs=\(String(format: "%.0f", self.lost * 1000), privacy: .public) \
                hitchMsPerS=\(String(format: "%.1f", self.lost * 1000 / max(seconds, 0.001)), privacy: .public) \
                worstMs=\(String(format: "%.0f", self.worst * 1000), privacy: .public)
                """)
        }
        reset(at: now)
    }
    private func reset(at now: CFTimeInterval) { started = now; frames = 0; late = 0; lost = 0; worst = 0 }
}
