import Foundation
import JavaScriptCore
import CoreFoundation

/// Owns one VM on one dedicated thread with a live run loop. No JSValue reaches SwiftUI.
final class ClientRuntime: @unchecked Sendable {
    private let lock = NSLock()
    private var loop: CFRunLoop?
    private var context: JSContext?
    private var thread: Thread?
    private var host: NativeHost?
    private var stopped = false
    private var finished = false
    private var completions: [@Sendable () -> Void] = []
    private let target: ConnectionTarget
    private let storageURL: URL
    private let receive: @Sendable (Data) -> Void
    private let fail: @Sendable (String) -> Void

    init(target: ConnectionTarget, storageURL: URL,
         receive: @escaping @Sendable (Data) -> Void, fail: @escaping @Sendable (String) -> Void) {
        self.target = target
        self.storageURL = storageURL
        self.receive = receive
        self.fail = fail
    }
    func start(itemLimit: Int = 200) {
        let ready = DispatchSemaphore(value: 0)
        let worker = Thread { [self] in
            let runLoop = CFRunLoopGetCurrent()
            let source = Port()
            RunLoop.current.add(source, forMode: .default)
            lock.withLock { loop = runLoop }
            ready.signal()
            autoreleasepool {
                guard let context = JSContext(virtualMachine: JSVirtualMachine()) else {
                    fail("Could not create the JavaScript runtime"); ready.signal(); return
                }
                self.context = context
                context.exceptionHandler = { [weak self] _, _ in self?.fail("The client runtime encountered a JavaScript error") }
                let native = NativeHost(runtime: self, target: target, storageURL: storageURL, receive: receive)
                host = native
                native.install(in: context)
                do {
                    guard let path = Bundle.main.url(forResource: "client", withExtension: "js") else { throw HostError.unsupported }
                    let script = try String(contentsOf: path, encoding: .utf8)
                    context.evaluateScript(script, withSourceURL: path)
                    let config = RuntimeConfig(deviceId: target.deviceId, hostId: target.hostId, itemLimit: itemLimit)
                    let json = String(decoding: try JSONEncoder().encode(config), as: UTF8.self)
                    context.objectForKeyedSubscript("aceStart")?.call(withArguments: [json])
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
        worker.qualityOfService = .userInitiated
        thread = worker
        worker.start()
        ready.wait()
    }
    func execute(_ work: @escaping @Sendable (JSContext) -> Void) {
        let runLoop = lock.withLock { stopped ? nil : loop }
        guard let runLoop else { return }
        CFRunLoopPerformBlock(runLoop, CFRunLoopMode.defaultMode.rawValue) { [weak self] in
            guard let self, let context = self.context else { return }
            autoreleasepool { work(context) }
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
        let runLoop = lock.withLock {
            stopped = true
            if finished { completion() } else { completions.append(completion) }
            return loop
        }
        if let runLoop { CFRunLoopStop(runLoop); CFRunLoopWakeUp(runLoop) }
    }
}
private struct RuntimeConfig: Encodable { let deviceId: String; let hostId: String; let itemLimit: Int }
/// The value is retained across an async native operation, then read/released only on the VM thread.
final class Callback: @unchecked Sendable { let value: JSValue; init(_ value: JSValue) { self.value = value } }
