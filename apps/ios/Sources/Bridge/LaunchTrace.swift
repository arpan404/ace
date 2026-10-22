import Foundation
import os

/// Launch and resume milestones as signposts (Instruments' Points of Interest) and log lines
/// carrying milliseconds since the process started, so a launch can be timed from the device log:
/// `log stream --predicate 'subsystem == "app.ace.ios" && category == "launch"'`.
enum LaunchTrace {
    nonisolated static let signposter = OSSignposter(subsystem: "app.ace.ios", category: .pointsOfInterest)
    nonisolated private static let log = Logger(subsystem: "app.ace.ios", category: "launch")
    /// The kernel's start time for this process, read once.
    nonisolated private static let processStart: Double = {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&name, 4, &info, &size, nil, 0) == 0 else { return Date().timeIntervalSince1970 * 1000 }
        let start = info.kp_proc.p_un.__p_starttime
        return Double(start.tv_sec) * 1000 + Double(start.tv_usec) / 1000
    }()

    /// Milliseconds since this process started.
    nonisolated static func sinceStart() -> Double { Date().timeIntervalSince1970 * 1000 - processStart }

    /// A one-off milestone, such as the first inbox row on screen.
    nonisolated static func mark(_ name: StaticString, _ detail: String = "") {
        signposter.emitEvent(name, "\(detail, privacy: .public)")
        log.notice("\(name, privacy: .public) \(String(format: "%.1f", sinceStart()), privacy: .public)ms \(detail, privacy: .public)")
    }

    /// A timed stretch of work (`end` closes it), such as evaluating the client bundle.
    nonisolated static func begin(_ name: StaticString, _ detail: String = "") -> Interval {
        let state = signposter.beginInterval(name, id: signposter.makeSignpostID(), "\(detail, privacy: .public)")
        return Interval(name: name, detail: detail, state: state, started: sinceStart())
    }

    struct Interval: Sendable {
        let name: StaticString
        let detail: String
        let state: OSSignpostIntervalState
        let started: Double
        nonisolated func end() {
            LaunchTrace.signposter.endInterval(name, state)
            let now = LaunchTrace.sinceStart()
            LaunchTrace.log.notice("\(name, privacy: .public) \(String(format: "%.1f", started), privacy: .public)→\(String(format: "%.1f", now), privacy: .public)ms (\(String(format: "%.1f", now - started), privacy: .public)ms) \(detail, privacy: .public)")
        }
    }
}
