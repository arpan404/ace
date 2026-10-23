import Foundation
import os
import QuartzCore

/// Time spent in each host capability and in the script itself, as signposts (Instruments'
/// "host" category) and, with the `-ace-host-trace` launch argument, as totals logged every five
/// seconds: `log stream --predicate 'subsystem == "app.ace.ios" && category == "host"'`.
enum HostTrace {
    nonisolated static let signposter = OSSignposter(subsystem: "app.ace.ios", category: "host")
    nonisolated private static let log = Logger(subsystem: "app.ace.ios", category: "host")
    nonisolated static let enabled = ProcessInfo.processInfo.arguments.contains("-ace-host-trace")
    private struct Total { var count = 0; var seconds = 0.0; var bytes = 0 }
    nonisolated private static let totals = OSAllocatedUnfairLock(initialState: (all: [String: Total](), dirty: false, started: false))

    /// Runs `body`, adding its time to `name`'s total.
    @inline(__always)
    nonisolated static func measure<T>(_ name: StaticString, bytes: Int = 0, _ body: () throws -> T) rethrows -> T {
        guard enabled else { return try body() }
        let state = signposter.beginInterval(name)
        let began = CACurrentMediaTime()
        defer {
            add("\(name)", seconds: CACurrentMediaTime() - began, bytes: bytes)
            signposter.endInterval(name, state)
        }
        return try body()
    }

    /// Adds one already-timed stretch, such as a span the script measured itself.
    nonisolated static func add(_ name: String, seconds: Double, bytes: Int = 0) {
        guard enabled else { return }
        let start = totals.withLock { state -> Bool in
            state.all[name, default: Total()].count += 1
            state.all[name, default: Total()].seconds += seconds
            state.all[name, default: Total()].bytes += bytes
            state.dirty = true
            defer { state.started = true }
            return !state.started
        }
        if start { schedule() }
    }

    nonisolated private static func schedule() {
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 5) {
            let lines: [String]? = totals.withLock { state in
                guard state.dirty else { return nil }
                state.dirty = false
                return state.all.sorted { $0.value.seconds > $1.value.seconds }.map { name, total in
                    String(format: "%@ n=%d ms=%.1f kb=%.1f", name, total.count, total.seconds * 1000, Double(total.bytes) / 1024)
                }
            }
            if let lines { log.notice("host.totals \(lines.joined(separator: " | "), privacy: .public)") }
            schedule()
        }
    }
}
