import Darwin
import Foundation

/// A runtime evaluating the client bundle before any machine is known (`ClientRuntime.warm`).
protocol WarmRuntime: AnyObject {
    func adopt(target: ConnectionTarget, storageURL: URL,
               receive: @escaping @Sendable (Data) -> Void, fail: @escaping @Sendable (String) -> Void) -> any ClientSession
    func stop(completion: @escaping @Sendable () -> Void)
}
extension ClientRuntime: WarmRuntime {
    func adopt(target: ConnectionTarget, storageURL: URL, receive: @escaping @Sendable (Data) -> Void,
               fail: @escaping @Sendable (String) -> Void) -> any ClientSession {
        let adopted: ClientRuntime = adopt(target: target, storageURL: storageURL, receive: receive, fail: fail)
        return adopted
    }
}

/// JavaScriptCore runtimes whose client bundle evaluates while the app starts, one for each
/// machine this phone remembers, so a machine's runtime is ready by the time it connects: during
/// Face ID and the first frame rather than after them. A warm runtime reads nothing and connects
/// nowhere until a machine adopts it; the first machine to connect takes the first one.
///
/// They warm one at a time: the first at once, each next one when the one before has evaluated,
/// below the first frame's priority until its own bundle has evaluated. So the first frame and
/// the first machine's connection never compete with three other parses of the bundle. A machine
/// that connects before its runtime is warm gets one at once. Those left once every machine has
/// connected are stopped.
@MainActor final class RuntimeWarmup {
    /// Makes a warm runtime at a priority; the callback runs, on any thread, once it evaluated.
    typealias Warm = (_ priority: QualityOfService, _ evaluated: @escaping @Sendable () -> Void) -> any WarmRuntime

    private var ready: [any WarmRuntime] = []
    /// Runtimes still to warm after the ones in `ready`.
    private var planned = 0
    private let warm: Warm

    init(warm: @escaping Warm = RuntimeWarmup.live) { self.warm = warm }

    func prepare(_ count: Int) {
        planned = max(0, min(count, Self.most) - ready.count)
        if planned > 0 { warmNext(priority: .userInitiated) }
    }
    private func warmNext(priority: QualityOfService) {
        guard planned > 0 else { return }
        planned -= 1
        ready.append(warm(priority) { [weak self] in
            Task { @MainActor [weak self] in self?.warmNext(priority: .utility) }
        })
    }
    /// A warm runtime bound to the machine, or a fresh one once none are left.
    func makeRuntime(_ target: ConnectionTarget, _ storage: URL, _ receive: @escaping @Sendable (Data) -> Void,
                     _ fail: @escaping @Sendable (String) -> Void) -> any ClientSession {
        if ready.isEmpty, planned > 0 {
            // A machine is connecting before its turn: its runtime starts now, at full priority.
            planned -= 1
            ready.append(warm(.userInitiated) { [weak self] in
                Task { @MainActor [weak self] in self?.warmNext(priority: .utility) }
            })
        }
        guard !ready.isEmpty else { return ClientRuntime(target: target, storageURL: storage, receive: receive, fail: fail) }
        return ready.removeFirst().adopt(target: target, storageURL: storage, receive: receive, fail: fail)
    }
    /// Stops the runtimes no machine took, such as one for a machine since removed elsewhere.
    func releaseUnused() {
        planned = 0
        for runtime in ready { runtime.stop(completion: {}) }
        ready.removeAll()
    }
    /// A VM holds tens of megabytes: never warm more than a phone usually pairs.
    private static let most = 4

    /// A `ClientRuntime` whose VM thread, if it started below user-initiated, rises to it once
    /// the bundle has evaluated: it will serve a machine the person is looking at.
    nonisolated static func live(_ priority: QualityOfService, _ evaluated: @escaping @Sendable () -> Void) -> any WarmRuntime {
        ClientRuntime.warm(priority: priority) {
            if priority != .userInitiated { pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, 0) }
            evaluated()
        }
    }
}
