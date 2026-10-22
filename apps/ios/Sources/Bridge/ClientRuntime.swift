import Foundation
import JavaScriptCore
import CoreFoundation
import QuartzCore

/// Owns one VM on one dedicated thread with a live run loop. No JSValue reaches SwiftUI.
final class ClientRuntime: ClientSession, @unchecked Sendable {
    private let lock = NSLock()
    private var loop: CFRunLoop?
    private var context: JSContext?
    private var thread: Thread?
    private var host: NativeHost?
    private var stopped = false
    private var finished = false
    private var completions: [@Sendable () -> Void] = []
    /// What the runtime serves; a warm runtime gets it from `adopt`. Guarded by `lock`.
    private var binding: HostBinding
    private var failure: (@Sendable (String) -> Void)?
    /// A problem a warm runtime met before it had a machine to report it to.
    private var early: String?
    /// How the VM thread competes for the CPU: below the machines' runtimes for background reads.
    private let priority: QualityOfService
    /// Browser stream messages this runtime's sockets decode natively, for the live view.
    let browserStreams: BrowserStreamHub? = BrowserStreamHub()

    init(target: ConnectionTarget, storageURL: URL,
         receive: @escaping @Sendable (Data) -> Void, fail: @escaping @Sendable (String) -> Void) {
        binding = HostBinding(target: target, storageURL: storageURL, services: .connection(target), receive: receive)
        failure = fail
        priority = .userInitiated
    }
    /// A pairing or machine-directory runtime: no outbox database and no client patches.
    init(access target: ConnectionTarget?, services: HostServices, priority: QualityOfService = .userInitiated,
         fail: @escaping @Sendable (String) -> Void) {
        binding = HostBinding(target: target, storageURL: nil, services: services, receive: { _ in })
        failure = fail
        self.priority = priority
    }
    private init(priority: QualityOfService) {
        binding = .unbound
        self.priority = priority
    }
    /// A machine runtime whose VM evaluates the client bundle now, before its machine is known,
    /// reading nothing and connecting nowhere until `adopt` gives it one (`RuntimeWarmup`).
    static func warm() -> ClientRuntime {
        let runtime = ClientRuntime(priority: .userInitiated)
        runtime.boot(then: nil)
        return runtime
    }
    /// Gives a warm runtime its machine. The host is bound on the VM thread after the bundle has
    /// evaluated and before `start` runs its entry, so no host call ever sees the unbound one.
    func adopt(target: ConnectionTarget, storageURL: URL,
               receive: @escaping @Sendable (Data) -> Void, fail: @escaping @Sendable (String) -> Void) -> ClientRuntime {
        let bound = HostBinding(target: target, storageURL: storageURL, services: .connection(target), receive: receive)
        let early = lock.withLock {
            binding = bound
            failure = fail
            defer { self.early = nil }
            return self.early
        }
        if let early { fail(early) }
        execute { [weak self] _ in self?.host?.bind(bound) }
        return self
    }
    private func fail(_ message: String) {
        let report = lock.withLock {
            if failure == nil { early = early ?? message }
            return failure
        }
        report?(message)
    }
    func start(itemLimit: Int = 200) {
        guard let target = lock.withLock({ binding.target }) else { fail("Could not load the shared client"); return }
        let config = RuntimeConfig(deviceId: target.deviceId, hostId: target.hostId, itemLimit: itemLimit,
                                   paired: target.secretKey.map { PairedConfig(secretKey: $0) })
        guard let json = try? JSONEncoder().encode(config) else { fail("Could not load the shared client"); return }
        let entry = (name: "aceStart", json: String(decoding: json, as: UTF8.self))
        if lock.withLock({ thread == nil }) { boot(then: entry); return }
        // Warm: the bundle is evaluated (or evaluating) on its thread; the entry runs after it.
        execute { [weak self] context in self?.run(entry, in: context) }
    }
    func startAccess(_ json: String) { boot(then: (name: "aceAccess", json: json)) }
    private func run(_ entry: (name: String, json: String), in context: JSContext) {
        let starting = LaunchTrace.begin("script.start", entry.name)
        defer { starting.end() }
        guard let function = context.objectForKeyedSubscript(entry.name), !function.isUndefined else {
            fail("Could not load the shared client"); return
        }
        function.call(withArguments: [entry.json])
    }
    /// Starts the VM thread and evaluates the bundle; then runs `entry`, unless the runtime is warm.
    private func boot(then entry: (name: String, json: String)?) {
        let label = entry?.name ?? "warm"
        let ready = DispatchSemaphore(value: 0)
        let worker = Thread { [self] in
            let runLoop = CFRunLoopGetCurrent()
            let source = Port()
            RunLoop.current.add(source, forMode: .default)
            lock.withLock { loop = runLoop }
            ready.signal()
            autoreleasepool {
                let creating = LaunchTrace.begin("vm.create", label)
                guard let context = JSContext(virtualMachine: JSVirtualMachine()) else {
                    fail("Could not create the JavaScript runtime"); return
                }
                self.context = context
                creating.end()
                context.exceptionHandler = { [weak self] _, _ in self?.fail("The client runtime encountered a JavaScript error") }
                let native = NativeHost(runtime: self, binding: lock.withLock { binding })
                host = native
                native.install(in: context)
                do {
                    guard let path = Bundle.main.url(forResource: "client", withExtension: "js") else { throw HostError.unsupported }
                    let reading = LaunchTrace.begin("script.read", label)
                    let script = try String(contentsOf: path, encoding: .utf8)
                    reading.end()
                    let evaluating = LaunchTrace.begin("script.evaluate", label)
                    context.evaluateScript(script, withSourceURL: path)
                    evaluating.end()
                    if let entry { run(entry, in: context) }
                } catch { fail("Could not load the shared client") }
            }
            CFRunLoopRun()
            host?.close()
            host = nil
            context = nil
            source.invalidate()
            let callbacks = lock.withLock {
                loop = nil
                thread = nil
                finished = true
                let callbacks = completions
                completions.removeAll()
                return callbacks
            }
            for callback in callbacks { callback() }
        }
        worker.name = "ace.client.javascript"
        worker.qualityOfService = priority
        lock.withLock { thread = worker }
        worker.start()
        ready.wait()
    }
    func execute(_ work: @escaping @Sendable (JSContext) -> Void) {
        let runLoop = lock.withLock { stopped ? nil : loop }
        guard let runLoop else { return }
        CFRunLoopPerformBlock(runLoop, CFRunLoopMode.defaultMode.rawValue) { [weak self] in
            guard let self, !self.lock.withLock({ self.stopped }), let context = self.context else { return }
            let began = CACurrentMediaTime()
            autoreleasepool { work(context) }
            let spent = CACurrentMediaTime() - began
            ThreadOpenTrace.scriptBusy.withLock { $0 += spent }
        }
        CFRunLoopWakeUp(runLoop)
    }
    func invoke(_ name: String, json: String) {
        execute { context in context.objectForKeyedSubscript(name)?.call(withArguments: [json]) }
    }
    func acknowledge(accepted: Bool) {
        execute { context in context.objectForKeyedSubscript("aceAck")?.call(withArguments: [accepted]) }
    }
    func stop(completion: @escaping @Sendable () -> Void = {}) {
        let state = lock.withLock {
            stopped = true
            if !finished { completions.append(completion) }
            return (loop, finished)
        }
        if state.1 { completion(); return }
        if let runLoop = state.0 {
            // Queue the stop: a direct stop before CFRunLoopRun begins can be lost.
            CFRunLoopPerformBlock(runLoop, CFRunLoopMode.defaultMode.rawValue) { CFRunLoopStop(runLoop) }
            CFRunLoopWakeUp(runLoop)
        }
    }
}
private struct PairedConfig: Encodable { let secretKey: String }
private struct RuntimeConfig: Encodable { let deviceId: String; let hostId: String; let itemLimit: Int; let paired: PairedConfig? }
/// The value is retained across an async native operation, then read/released only on the VM thread.
final class Callback: @unchecked Sendable { let value: JSValue; init(_ value: JSValue) { self.value = value } }
