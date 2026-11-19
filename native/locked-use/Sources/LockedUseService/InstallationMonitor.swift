import Foundation
import LockedUseSystem

/// Holds the latest read-only installation probe results. Probes (code-signature checks,
/// authorization-database reads, `sysadminctl`) can take hundreds of milliseconds, so they
/// run on `queue`, never on the main thread, whose run loop also drives the coordinator's
/// heartbeat and the cover's event tap. Results come back on the main actor.
@MainActor public final class LockedUseInstallationMonitor {
    public typealias Probe = @Sendable () -> LockedUseInstallationFacts
    /// Last completed probe. All false until the first probe finishes.
    public private(set) var facts = LockedUseInstallationFacts()
    private let queue: DispatchQueue
    private let probe: Probe
    private var running = false

    public init(queue: DispatchQueue, probe: @escaping Probe) {
        self.queue = queue
        self.probe = probe
    }

    /// Starts a probe unless one is already running, and returns at once.
    public func refresh(done: @escaping @MainActor () -> Void = {}) {
        guard !running else { return }
        running = true
        let probe = probe
        queue.async {
            let result = probe()
            DispatchQueue.main.async {
                MainActor.assumeIsolated { [weak self] in
                    guard let self else { return }
                    facts = result
                    running = false
                    done()
                }
            }
        }
    }
}
