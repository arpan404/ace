import Foundation
import JavaScriptCore
import CoreFoundation

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
    private let target: ConnectionTarget?
    private let storageURL: URL?
    private let services: HostServices
    private let receive: @Sendable (Data) -> Void
    private let fail: @Sendable (String) -> Void
    /// Browser stream messages this runtime's sockets decode natively, for the live view.
    let browserStreams: BrowserStreamHub? = BrowserStreamHub()

    init(target: ConnectionTarget, storageURL: URL,
         receive: @escaping @Sendable (Data) -> Void, fail: @escaping @Sendable (String) -> Void) {
        self.target = target
        self.storageURL = storageURL
        self.services = .connection(target)
        self.receive = receive
        self.fail = fail
    }
    /// A pairing or machine-directory runtime: no outbox database and no client patches.
    init(access target: ConnectionTarget?, services: HostServices, fail: @escaping @Sendable (String) -> Void) {
        self.target = target
        self.storageURL = nil
        self.services = services
        self.receive = { _ in }
        self.fail = fail
    }
    func start(itemLimit: Int = 200) {
        guard let target else { fail("Could not load the shared client"); return }
        let config = RuntimeConfig(deviceId: target.deviceId, hostId: target.hostId, itemLimit: itemLimit,
                                   paired: target.secretKey.map { PairedConfig(secretKey: $0) })
        guard let json = try? JSONEncoder().encode(config) else { fail("Could not load the shared client"); return }
        boot(entry: "aceStart", json: String(decoding: json, as: UTF8.self))
    }
    func startAccess(_ json: String) { boot(entry: "aceAccess", json: json) }
    private func boot(entry: String, json: String) {
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
                let native = NativeHost(runtime: self, target: target, storageURL: storageURL, services: services, receive: receive)
                host = native
                native.install(in: context)
                do {
                    guard let path = Bundle.main.url(forResource: "client", withExtension: "js") else { throw HostError.unsupported }
                    let script = try String(contentsOf: path, encoding: .utf8)
                    context.evaluateScript(script, withSourceURL: path)
                    context.objectForKeyedSubscript(entry)?.call(withArguments: [json])
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
            guard let self, !self.lock.withLock({ self.stopped }), let context = self.context else { return }
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
