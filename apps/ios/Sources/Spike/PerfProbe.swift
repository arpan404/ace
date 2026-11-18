import Foundation

/// Fixture builds launched with `--perf-probe --perf-probe-run ID`: the newest launch,
/// thread-open, bridge and frame numbers, `key=value` pairs joined by `;`, posted to the
/// fixture's `/perf-probe` under the run `ID` so the performance UI tests
/// (`UITests/PerformanceBudgetUITests.swift`) can hold the app to its budgets.
///
/// The numbers once sat in a hidden accessibility element. Each read made XCUITest snapshot the
/// app's whole accessibility tree on the main thread, about a fifth of the main thread's time
/// while reading far back, and those snapshots landed inside the page, frame and open timings
/// the budgets hold. Posting costs the main thread one short string every `pace`.
/// Release builds compile it away; nothing in the app reads it.
@MainActor final class PerfProbe {
    static let shared = PerfProbe()
    nonisolated static let enabled: Bool = {
        #if ACE_FIXTURE
        ProcessInfo.processInfo.arguments.contains("--perf-probe")
        #else
        false
        #endif
    }()
    /// The fixture's `/perf-probe` and this launch's run, or nil when the test passed no run.
    nonisolated private static let destination: (url: URL, run: String)? = {
        let arguments = ProcessInfo.processInfo.arguments
        guard enabled,
              let run = arguments.firstIndex(of: "--perf-probe-run").flatMap({ arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }),
              let url = URL(string: "http://127.0.0.1:\(SpikeConfiguration.port)/perf-probe") else { return nil }
        return (url, run)
    }()
    /// At most one post per this long, so a burst of numbers goes as one.
    private static let pace: Duration = .milliseconds(50)
    private var values: [String: String] = [:]
    private var posting: Task<Void, Never>?

    /// Records numbers from any thread; the main thread stores them.
    nonisolated static func record(_ entries: [String: String]) {
        guard enabled else { return }
        Task { @MainActor in shared.store(entries) }
    }
    private func store(_ entries: [String: String]) {
        for (key, value) in entries { values[key] = value }
        changed()
    }
    /// Sums a value, such as a count of frames over a whole run.
    nonisolated static func add(_ key: String, _ amount: Double) {
        guard enabled else { return }
        Task { @MainActor in
            let total = (Double(shared.values[key] ?? "0") ?? 0) + amount
            shared.values[key] = String(format: "%.1f", total)
            shared.changed()
        }
    }
    var text: String { values.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ";") }

    private func changed() {
        guard posting == nil, let destination = Self.destination else { return }
        posting = Task { @MainActor [weak self] in
            try? await Task.sleep(for: Self.pace)
            guard let self else { return }
            self.posting = nil
            Self.post(self.text, to: destination.url, run: destination.run)
        }
    }
    /// Off the main thread; a lost post is replaced by the next one.
    nonisolated private static func post(_ text: String, to url: URL, run: String) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["run": run, "text": text])
        URLSession.shared.dataTask(with: request).resume()
    }
}
