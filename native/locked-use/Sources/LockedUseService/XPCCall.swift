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

/// Non-blocking form of `lockedUseCall`: sends the request and returns at once. `done`
/// runs exactly once on the main actor with the reply, or false on a link error or after
/// `timeout`. The caller's thread never waits, so main-thread timers and the event tap
/// keep running while the peer is slow.
@MainActor func lockedUseCallAsync<Proxy>(_ connection: NSXPCConnection, timeout: DispatchTimeInterval,
                                          _ body: (Proxy, @escaping (Bool) -> Void) -> Void,
                                          done: @escaping @MainActor (Bool) -> Void) {
    let once = XPCOnce { value in DispatchQueue.main.async { MainActor.assumeIsolated { done(value) } } }
    guard let proxy = connection.remoteObjectProxyWithErrorHandler({ _ in once.finish(false) }) as? Proxy else {
        return once.finish(false)
    }
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) { once.finish(false) }
    body(proxy) { once.finish($0) }
}

private final class XPCOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    private let deliver: (Bool) -> Void

    init(_ deliver: @escaping (Bool) -> Void) { self.deliver = deliver }

    func finish(_ value: Bool) {
        lock.lock()
        let first = !finished
        finished = true
        lock.unlock()
        if first { deliver(value) }
    }
}
