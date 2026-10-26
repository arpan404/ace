import Foundation
import os
import QuartzCore

/// Timing for opening something in place in the transcript: a settled "Worked for" log, a step's
/// detail, a thought, or a message read in full. From the tap to its content laid out (and, for a
/// log, whether its rows had to load first), and the bridge traffic applied in the 1.5 s after the
/// tap, which is what the open caused (a read, its pages, anything sent again). One
/// signpost interval and one `perf` log line per open; the numbers also go to `--perf-probe`.
/// Measurement only: nothing reads it.
@MainActor final class DisclosureTrace {
    static let shared = DisclosureTrace()
    private struct Open {
        let kind: String
        let key: String
        let asked: Double
        let interval: OSSignpostIntervalState
        var waited = false
        var shownMs: Double?
        var frames = 0, patches = 0, bytes = 0
        var mainMs = 0.0
    }
    private var open: Open?

    /// The person tapped to open `key`.
    func asked(_ kind: String, key: String) {
        if let open { finish(open.key) }
        open = Open(kind: kind, key: key, asked: CACurrentMediaTime(),
                    interval: ThreadOpenTrace.signposter.beginInterval("disclosure.open", id: ThreadOpenTrace.signposter.makeSignpostID(), "\(kind, privacy: .public)"))
    }
    /// What opened had nothing to show yet and waited on a read.
    func waiting(_ key: String) {
        if open?.key == key { open?.waited = true }
    }
    /// One bridge frame applied while an open was under way.
    func frame(bytes: Int, patches: Int, seconds: Double) {
        guard open != nil else { return }
        open?.frames += 1; open?.patches += patches; open?.bytes += bytes; open?.mainMs += seconds * 1000
    }
    /// The content of `key` was laid out; it is on screen once this update commits, on the next
    /// turn of the run loop. The traffic window closes 1.5 s after the tap.
    func shown(_ key: String) {
        guard let current = open, current.key == key, current.shownMs == nil else { return }
        DispatchQueue.main.async {
            guard self.open?.key == key, self.open?.asked == current.asked else { return }
            let now = CACurrentMediaTime()
            self.open?.shownMs = (now - current.asked) * 1000
            ThreadOpenTrace.signposter.endInterval("disclosure.open", current.interval)
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0, current.asked + 1.5 - now)) {
                if self.open?.asked == current.asked { self.finish(key) }
            }
        }
    }
    private func finish(_ key: String) {
        guard let open, open.key == key else { return }
        self.open = nil
        guard let shown = open.shownMs else {
            ThreadOpenTrace.signposter.endInterval("disclosure.open", open.interval)
            return
        }
        let ms = String(format: "%.0f", shown)
        ThreadOpenTrace.log.notice("""
            disclosure kind=\(open.kind, privacy: .public) shownMs=\(ms, privacy: .public) waited=\(open.waited) \
            frames=\(open.frames) patches=\(open.patches) bytes=\(open.bytes) mainApplyMs=\(String(format: "%.1f", open.mainMs), privacy: .public)
            """)
        PerfProbe.record(["disclosure.kind": open.kind, "disclosure.shownMs": ms, "disclosure.waited": "\(open.waited)",
                          "disclosure.patches": "\(open.patches)", "disclosure.bytes": "\(open.bytes)",
                          "disclosure.mainMs": String(format: "%.1f", open.mainMs)])
        PerfProbe.add("disclosures", 1)
    }
}
