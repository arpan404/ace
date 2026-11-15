import Foundation
import os
import Synchronization

/// Fixture builds launched with `--perf-log`: counts of the transcript's layout work, logged as
/// per-second deltas under `dev.ace.perf`, to find what keeps the lazy feed re-placing (#2051).
/// The counts live behind a lock and are logged from a background queue, so a main thread pinned
/// in layout still reports. Read them with
/// `xcrun simctl spawn booted log stream --predicate 'subsystem == "dev.ace.perf"'`.
/// With `--perf-probe` the running totals also go to the probe as `count.<name>`.
/// Release builds compile it away.
enum PerfCounters {
    nonisolated static let enabled: Bool = {
        #if ACE_FIXTURE
        ProcessInfo.processInfo.arguments.contains("--perf-log")
        #else
        false
        #endif
    }()
    private static let counts = Mutex<[String: Int]>([:])
    private static let logger = Logger(subsystem: "dev.ace.perf", category: "feed")
    private static let ticker: DispatchSourceTimer? = {
        guard enabled else { return nil }
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "dev.ace.perf"))
        var last: [String: Int] = [:]
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler {
            let now = counts.withLock { $0 }
            let deltas = now.keys.sorted().compactMap { key -> String? in
                let delta = now[key, default: 0] - last[key, default: 0]
                return delta == 0 ? nil : "\(key)+\(delta)"
            }
            last = now
            guard !deltas.isEmpty else { return }
            logger.log("per second: \(deltas.joined(separator: " "), privacy: .public)")
            PerfProbe.record(Dictionary(uniqueKeysWithValues: now.map { ("count.\($0.key)", String($0.value)) }))
        }
        timer.resume()
        return timer
    }()

    /// Counts one `name`, such as a body evaluation or a row laid out again.
    nonisolated static func bump(_ name: String) {
        guard enabled else { return }
        _ = ticker
        counts.withLock { $0[name, default: 0] += 1 }
    }
}
