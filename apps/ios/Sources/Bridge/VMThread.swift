import Foundation
import JavaScriptCore
import QuartzCore

/// The one thread a runtime's JavaScriptCore VM runs on. Every JSContext and JSValue call, and
/// every JSValue release, belongs there. Debug builds stop at the first use from anywhere else
/// and name it; release builds skip the check.
final class VMThread: @unchecked Sendable {
    private let lock = NSLock()
    private var thread: Thread?

    /// Set before the thread starts, so the check holds from the VM's first instruction.
    func adopt(_ thread: Thread) { lock.withLock { self.thread = thread } }
    var isCurrent: Bool { lock.withLock { thread } === Thread.current }

    /// Fails loudly in debug builds when called off the VM thread.
    func check(_ use: @autoclosure () -> String, file: StaticString = #fileID, line: UInt = #line) {
        assert(isCurrent, "JavaScriptCore entered off its VM thread (\(use())) from \(Thread.current)", file: file, line: line)
    }
}

/// A JSValue that a native queue may hold while its operation runs, but that is only called,
/// and finally let go, on its runtime's VM thread.
final class Callback: @unchecked Sendable {
    private var value: JSValue?
    private let vm: VMThread
    private weak var runtime: ClientRuntime?
    private let traced: String?
    private let began: Double

    init(_ value: JSValue, runtime: ClientRuntime?, traced: String? = nil, began: Double = 0) {
        self.value = value; self.runtime = runtime; self.traced = traced; self.began = began
        vm = runtime?.vm ?? VMThread()
        vm.check("callback retained")
    }
    /// Adds the operation's time, request to native reply, to the host totals when traced.
    func finish() { if let traced { HostTrace.add("host.call:" + traced, seconds: CACurrentMediaTime() - began) } }
    @discardableResult func call(_ arguments: [Any]) -> JSValue? {
        vm.check("callback called")
        return value?.call(withArguments: arguments)
    }
    deinit {
        // The last owner is often the queue that answered. Its release would enter JavaScriptCore
        // there, so the value goes back to the VM thread to be let go. A stopped runtime's queue
        // drops it wherever it is: JavaScriptCore locks that release, and the VM is going away.
        guard !vm.isCurrent, let value, let runtime else { return }
        let held = Held(value)
        self.value = nil
        runtime.execute { _ in held.release() }
    }
}

/// Carries a JSValue to the VM thread, where `release` drops it.
private final class Held: @unchecked Sendable {
    private var value: JSValue?
    init(_ value: JSValue) { self.value = value }
    func release() { value = nil }
}
