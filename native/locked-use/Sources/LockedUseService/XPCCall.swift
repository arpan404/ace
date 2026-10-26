import Foundation

/// Sends one XPC request and waits at most `timeout` for its boolean reply. A link error,
/// a missing proxy or a timeout all read as false. The reply arrives on XPC's own queue,
/// so waiting here never needs the caller's thread.
func lockedUseCall<Proxy>(_ connection: NSXPCConnection, timeout: DispatchTimeInterval,
                          _ body: (Proxy, @escaping (Bool) -> Void) -> Void) -> Bool {
    let result = XPCResult()
    guard let proxy = connection.remoteObjectProxyWithErrorHandler({ _ in result.finish(false) }) as? Proxy else { return false }
    body(proxy) { result.finish($0) }
    return result.wait(timeout)
}

private final class XPCResult: @unchecked Sendable {
    private let lock = NSLock()
    private let done = DispatchSemaphore(value: 0)
    private var value: Bool?

    func finish(_ value: Bool) {
        lock.lock()
        let first = self.value == nil
        if first { self.value = value }
        lock.unlock()
        if first { done.signal() }
    }

    func wait(_ timeout: DispatchTimeInterval) -> Bool {
        guard done.wait(timeout: .now() + timeout) == .success else { return false }
        lock.lock()
        defer { lock.unlock() }
        return value ?? false
    }
}
