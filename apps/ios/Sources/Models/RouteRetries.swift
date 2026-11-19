import Foundation

/// Runs `work` after `delay` milliseconds and returns what cancels it. Injected, so tests move
/// time themselves instead of sleeping.
typealias RouteScheduler = @MainActor (_ delay: Double, _ work: @escaping @MainActor () -> Void) -> @MainActor () -> Void

/// At most one pending look at each machine's route (`MachineRoutePlan.Step.reconsider`), by
/// host id. A new one replaces the old; turning the machine off, removing it or moving its
/// route cancels it.
@MainActor struct RouteRetries {
    private let schedule: RouteScheduler
    private var cancels: [String: @MainActor () -> Void] = [:]
    init(schedule: @escaping RouteScheduler) { self.schedule = schedule }

    mutating func set(_ hostId: String, after delay: Double, _ work: @escaping @MainActor () -> Void) {
        cancel(hostId)
        cancels[hostId] = schedule(max(0, delay), work)
    }
    mutating func cancel(_ hostId: String) { cancels.removeValue(forKey: hostId)?() }

    /// The app's scheduler: a task that sleeps, then runs the work unless cancelled first.
    static let sleeping: RouteScheduler = { delay, work in
        let task = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(Int(delay.rounded(.up))))
            if !Task.isCancelled { work() }
        }
        return { task.cancel() }
    }
}
