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
    /// Time lost to late frames since launch, never reset, so a test can read what one stretch
    /// of scrolling cost without a five-second window mixing in idle time.
    private var lostTotal = 0.0

    /// Main-thread time spent between waking and sleeping again, since launch.
    private var busy: CFRunLoopObserver?
    private var wokeAt: CFTimeInterval?
    private var busyTotal = 0.0
    private var busyPublished: CFTimeInterval = 0

    func run(_ on: Bool) {
        guard on != (link != nil) else { return }
        if on {
            watchBusy()
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
            if gap > interval * 1.5 {
                late += 1; lost += gap - interval; lostTotal += gap - interval
                PerfProbe.record(["frames.lostMsTotal": String(format: "%.1f", lostTotal * 1000)])
            }
            worst = max(worst, gap)
        }
        last = now
        // Published from the frame callback, never the run-loop observer: a record there would
        // wake the run loop it measures.
        if now - busyPublished >= 0.25 {
            busyPublished = now
            PerfProbe.record(["main.busyMsTotal": String(format: "%.0f", busyTotal * 1000)])
        }
        if now - started >= 5 { report(at: now) }
    }
    private func report(at now: CFTimeInterval) {
        if late > 0 || frames > 0 {
            let seconds = now - started
            PerfProbe.record(["frames.late": "\(late)", "frames.hitchMsPerS": String(format: "%.1f", lost * 1000 / max(seconds, 0.001)),
                              "frames.worstMs": String(format: "%.0f", worst * 1000)])
            PerfProbe.add("frames.windows", 1)
            // The probe's numbers in the log too, for runs driven without an accessibility
            // client (whose snapshots of a long transcript can stall the run they measure).
            if PerfProbe.enabled { ThreadOpenTrace.log.notice("probe \(PerfProbe.shared.text, privacy: .public)") }
            ThreadOpenTrace.log.notice("""
                frames window=\(String(format: "%.1f", seconds), privacy: .public)s frames=\(self.frames) late=\(self.late) \
                lostMs=\(String(format: "%.0f", self.lost * 1000), privacy: .public) \
                hitchMsPerS=\(String(format: "%.1f", self.lost * 1000 / max(seconds, 0.001)), privacy: .public) \
                worstMs=\(String(format: "%.0f", self.worst * 1000), privacy: .public)
                """)
        }
        reset(at: now)
    }
    /// Counts how long the main run loop works between waits, so a test can read the main
    /// thread's busy share over a stretch of scrolling.
    private func watchBusy() {
        guard busy == nil else { return }
        let activities = CFRunLoopActivity.afterWaiting.rawValue | CFRunLoopActivity.beforeWaiting.rawValue
        let observer = CFRunLoopObserverCreateWithHandler(nil, activities, true, 0) { [weak self] _, activity in
            MainActor.assumeIsolated {
                guard let self else { return }
                let now = CACurrentMediaTime()
                if activity == .afterWaiting { self.wokeAt = now; return }
                guard let woke = self.wokeAt else { return }
                self.wokeAt = nil
                self.busyTotal += now - woke
            }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes)
        busy = observer
    }
    private func reset(at now: CFTimeInterval) { started = now; frames = 0; late = 0; lost = 0; worst = 0 }
}
