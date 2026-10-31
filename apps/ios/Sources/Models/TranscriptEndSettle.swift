import Foundation

/// Lazy rows measure themselves only as they come into view, so one scroll to the end can stop
/// short of it, or past it on an empty stretch where no row is drawn, when the rows it passed
/// turn out taller or shorter than estimated (or were swapped, leaving the history window). After
/// each scroll to the end this looks again every frame and scrolls once more until the end has
/// sat at the bottom for two frames, the person scrolls, or about half a second of looking has
/// passed. Repeated requests share that budget. Frames spent waiting on an animated scroll
/// don't count.
@MainActor final class TranscriptEndSettle {
    private var task: Task<Void, Never>?
    private var generation = 0
    var isRunning: Bool { task != nil }
    private let pause: @MainActor () async throws -> Void

    init(pause: @escaping @MainActor () async throws -> Void = { try await Task.sleep(for: .milliseconds(16)) }) {
        self.pause = pause
    }
    /// `gap`: how far the end is from the bottom (negative past it), or nil to stop; `wait`: true
    /// while an animated scroll is still carrying the rows there.
    func run(gap: @escaping @MainActor () -> CGFloat?, wait: @escaping @MainActor () -> Bool, scroll: @escaping @MainActor () -> Void) {
        // Lazy-layout feedback joins this correction instead of resetting its deadline.
        guard task == nil else { return }
        generation += 1
        let started = generation
        task = Task<Void, Never> { @MainActor in
            defer { if generation == started { task = nil } }
            var steady = 0, looks = 0, waits = 0
            while looks < 30, waits < 120 {
                do { try await pause() } catch { return }
                guard !Task.isCancelled, let gap = gap() else { return }
                if wait() { waits += 1; continue }
                looks += 1
                if abs(gap) <= 1 {
                    steady += 1
                    if steady == 2 { return }
                } else {
                    steady = 0
                    scroll()
                }
            }
        }
    }
    func cancel() { generation += 1; task?.cancel(); task = nil }
}
