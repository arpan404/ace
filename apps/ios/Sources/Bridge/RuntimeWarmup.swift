import Foundation

/// JavaScriptCore runtimes whose client bundle evaluates while the app starts, one for each
/// machine this phone remembers, so a machine's runtime is ready by the time it connects: during
/// Face ID and the first frame rather than after them. A warm runtime reads nothing and connects
/// nowhere until a machine adopts it. Those left once every machine has connected are stopped.
@MainActor final class RuntimeWarmup {
    private var ready: [ClientRuntime] = []
    private let warm: () -> ClientRuntime

    init(warm: @escaping () -> ClientRuntime = { ClientRuntime.warm() }) { self.warm = warm }

    func prepare(_ count: Int) {
        while ready.count < min(count, Self.most) { ready.append(warm()) }
    }
    /// A warm runtime bound to the machine, or a fresh one once none are left.
    func makeRuntime(_ target: ConnectionTarget, _ storage: URL, _ receive: @escaping @Sendable (Data) -> Void,
                     _ fail: @escaping @Sendable (String) -> Void) -> any ClientSession {
        guard !ready.isEmpty else { return ClientRuntime(target: target, storageURL: storage, receive: receive, fail: fail) }
        return ready.removeFirst().adopt(target: target, storageURL: storage, receive: receive, fail: fail)
    }
    /// Stops the runtimes no machine took, such as one for a machine since removed elsewhere.
    func releaseUnused() {
        for runtime in ready { runtime.stop() }
        ready.removeAll()
    }
    /// A VM holds tens of megabytes: never warm more than a phone usually pairs.
    private static let most = 4
}
