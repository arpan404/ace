import SwiftUI
import Observation

/// Fixture builds launched with `--perf-probe`: the newest launch, thread-open, bridge and frame
/// numbers as one hidden accessibility value, `key=value` pairs joined by `;`, so the performance
/// UI tests (`UITests/PerformanceBudgetUITests.swift`) can hold the app to its budgets. Release
/// builds compile it away; nothing in the app reads it.
@MainActor @Observable final class PerfProbe {
    static let shared = PerfProbe()
    nonisolated static let enabled: Bool = {
        #if ACE_FIXTURE
        ProcessInfo.processInfo.arguments.contains("--perf-probe")
        #else
        false
        #endif
    }()
    private var values: [String: String] = [:]

    /// Records numbers from any thread; the main thread stores them.
    nonisolated static func record(_ entries: [String: String]) {
        guard enabled else { return }
        Task { @MainActor in shared.store(entries) }
    }
    private func store(_ entries: [String: String]) {
        for (key, value) in entries { values[key] = value }
    }
    /// Sums a value, such as a count of frames over a whole run.
    nonisolated static func add(_ key: String, _ amount: Double) {
        guard enabled else { return }
        Task { @MainActor in
            let total = (Double(shared.values[key] ?? "0") ?? 0) + amount
            shared.values[key] = String(format: "%.1f", total)
        }
    }
    var text: String { values.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ";") }
}

/// The probe's one-point, invisible element. Present only with `--perf-probe`.
struct PerfProbeView: View {
    var body: some View {
        if PerfProbe.enabled {
            Color.clear.frame(width: 1, height: 1)
                .accessibilityElement()
                .accessibilityIdentifier("perf.probe")
                .accessibilityValue(PerfProbe.shared.text)
                .allowsHitTesting(false)
        }
    }
}
