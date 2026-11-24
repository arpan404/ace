import Foundation

/// One OS callback's completion (a BGAppRefresh task, a remote notification's fetch handler):
/// iOS wants it reported exactly once, and before the time it granted runs out, or it kills the
/// app. The work may take longer than that: a stalled ActivityKit update, a socket that never
/// answers, a shared refresh another wake started. So the report never waits for it. Expiration
/// or the deadline reports failure at once, and whatever the work returns afterwards is ignored.
///
/// Pure: times are milliseconds on the caller's clock, passed in.
struct CompletionGate: Equatable {
    /// The latest moment the report may go.
    let deadline: Double
    /// What was reported, once it was.
    private(set) var reported: Bool?

    init(startedAt: Double, budget: Double) { deadline = startedAt + budget }

    /// The work finished: what to report now, or nil when the report already went. A result
    /// arriving past the deadline is a failure, whatever it says.
    mutating func finish(_ success: Bool, at now: Double) -> Bool? {
        guard reported == nil else { return nil }
        reported = success && now <= deadline
        return reported
    }
    /// iOS is taking its time back, or the deadline passed: failure now, unless already reported.
    mutating func expire() -> Bool? {
        guard reported == nil else { return nil }
        reported = false
        return false
    }
    func remaining(at now: Double) -> Double { max(0, deadline - now) }
}

/// The shell around a `CompletionGate`: calls the OS's handler through it and expires it at its
/// own deadline, independent of the work's cooperative budget.
@MainActor final class OSCompletion {
    private var gate: CompletionGate
    private let now: () -> Double
    private var report: ((Bool) -> Void)?
    private var timer: Task<Void, Never>?

    init(budget: Duration, now: @escaping () -> Double, sleep: @escaping @Sendable (Duration) async -> Void,
         report: @escaping (Bool) -> Void) {
        let start = now()
        let millis = Double(budget.components.seconds) * 1000 + Double(budget.components.attoseconds) / 1e15
        gate = CompletionGate(startedAt: start, budget: millis)
        self.now = now
        self.report = report
        timer = Task { @MainActor [weak self] in
            await sleep(budget)
            self?.expire()
        }
    }
    /// The work's own result; ignored once the report went.
    func finish(_ success: Bool) { send(gate.finish(success, at: now())) }
    /// iOS's expiration handler, or the deadline.
    func expire() { send(gate.expire()) }

    private func send(_ value: Bool?) {
        guard let value, let report else { return }
        self.report = nil
        timer?.cancel()
        timer = nil
        report(value)
    }
}
