import Foundation
import JavaScriptCore
import QuartzCore

/// What a runtime serves: its daemon, its outbox database, its native services and where its
/// patches go. A warm runtime (`RuntimeWarmup`) evaluates the client bundle before it has one.
struct HostBinding: Sendable {
    var target: ConnectionTarget?
    var storageURL: URL?
    var services: HostServices
    var receive: @Sendable (Data) -> Void
    static let unbound = HostBinding(target: nil, storageURL: nil, services: HostServices(), receive: { _ in })
}

/// All mutable dictionaries live on ClientRuntime's thread. Disk work has its own serial queue.
final class NativeHost: @unchecked Sendable {
    private weak var runtime: ClientRuntime?
    /// Set at creation, or once on the VM thread before the bundle starts; never changed after.
    private var binding: HostBinding
    private var target: ConnectionTarget? { binding.target }
    private var storageURL: URL? { binding.storageURL }
    private var services: HostServices { binding.services }
    private var receive: @Sendable (Data) -> Void { binding.receive }
    private let storageQueue = DispatchQueue(label: "ace.client.storage", qos: .userInitiated)
    /// Read snapshots have their own queue, so a large cache write never delays an outbox admission.
    private let snapshotQueue = DispatchQueue(label: "ace.client.snapshots", qos: .userInitiated)
    private var store: DurableStore?
    private var snapshots: SnapshotStore?
    private var sockets: [String: PinnedSocket] = [:]
    private var timers: [String: Timer] = [:]

    init(runtime: ClientRuntime, binding: HostBinding) {
        self.runtime = runtime; self.binding = binding
    }
    /// A warm runtime's machine, on the VM thread before its entry runs: nothing has called the
    /// host yet, and every later call (and the queues it dispatches to) reads this binding.
    func bind(_ binding: HostBinding) { self.binding = binding }
    /// Installs `aceHost`: the stateless capabilities (`HostContract`) and this runtime's own.
    func install(in context: JSContext) {
        let call: @convention(block) (String, String, JSValue, JSValue) -> Void = { [weak self] operation, json, body, value in
            // The body is the operation's large text, sent unescaped; absent unless a string.
            let text = body.isString ? body.toString() : nil
            self?.call(HostRequest(operation, input: Data(json.utf8), body: text), callback: Callback(value))
        }
        let emit: @convention(block) (String) -> Void = { [weak self] json in
            guard let data = HostTrace.measure("host.emit", { json.data(using: .utf8) }), data.count <= 32768 else { return }
            HostTrace.add("host.emit.bytes", seconds: 0, bytes: data.count)
            self?.receive(data)
        }
        let socket: @convention(block) (String, String, String) -> Void = { [weak self] id, action, text in self?.socket(id, action: action, text: text) }
        let timer: @convention(block) (String, Double, JSValue) -> Void = { [weak self] id, delay, value in
            self?.setTimer(id, delay: delay, callback: Callback(value))
        }
        let cancel: @convention(block) (String) -> Void = { [weak self] id in self?.timers.removeValue(forKey: id)?.invalidate() }
        let own: [String: Any] = ["call": call, "emit": emit, "socket": socket, "timer": timer, "cancelTimer": cancel]
        HostContract.install(HostContract.stateless().merging(own) { _, runtime in runtime }, in: context)
    }
    /// Inputs past this are refused before any work; bodies have each operation's own cap.
    private static let inputLimit = 1024 * 1024
    private static let bodyLimit = 9 * 1024 * 1024
    private func call(_ request: HostRequest, callback: Callback) {
        let operation = request.operation
        let callback = HostTrace.enabled ? Callback(callback.value, traced: operation, began: CACurrentMediaTime()) : callback
        guard request.input.count <= Self.inputLimit, (request.body?.utf8.count ?? 0) <= Self.bodyLimit else {
            reply(.failure(HostError.storage), to: callback); return
        }
        if operation == "http" { http(request.input, callback: callback); return }
        if operation.hasPrefix("snapshot.") { snapshot(request, callback: callback); return }
        storageQueue.async { [self] in
            let result: Result<String, Error> = Result {
                if operation == "credential" {
                    guard let target, target.isLoopbackFixture else { throw HostError.unsupported }
                    return try target.credential()
                }
                if let value = try services.perform(request) { return value }
                guard let storageURL else { throw HostError.unsupported }
                if operation == "inbox.checkpoint" {
                    try InboxCheckpoint.write(try request.requireBody(), database: storageURL)
                    return ""
                }
                if store == nil { store = try DurableStore(url: storageURL) }
                guard let store else { throw HostError.storage }
                return try store.perform(request)
            }
            reply(result, to: callback)
        }
    }
    private func snapshot(_ request: HostRequest, callback: Callback) {
        snapshotQueue.async { [self] in
            let result: Result<String, Error> = Result {
                guard let storageURL else { throw HostError.storage }
                if snapshots == nil { snapshots = try SnapshotStore(database: storageURL, now: services.now) }
                guard let value = try snapshots?.perform(request) else { throw HostError.unsupported }
                return value
            }
            reply(result, to: callback)
        }
    }
    private func reply(_ result: Result<String, Error>, to callback: Callback) {
        callback.finish()
        runtime?.execute { _ in HostTrace.measure("js.reply") {
            switch result {
            case .success(let text): callback.value.call(withArguments: [NSNull(), text])
            case .failure(let error): callback.value.call(withArguments: [HostError.code(of: error), ""])
            }
        } }
    }
    /// Pinned HTTPS to this runtime's own daemon. Refusals reach the bridge as their reason.
    private func http(_ input: Data, callback: Callback) {
        let runtime = runtime
        let reply: @Sendable (Result<PinnedHTTPResponse, PinnedHTTPError>) -> Void = { result in
            let encoded = result.flatMap { response in
                (try? JSONEncoder().encode(response)).map { Result.success(String(decoding: $0, as: UTF8.self)) } ?? .failure(.invalid)
            }
            runtime?.execute { _ in
                switch encoded {
                case .success(let text): callback.value.call(withArguments: [NSNull(), text])
                case .failure(let reason): callback.value.call(withArguments: [reason.rawValue, ""])
                }
            }
        }
        guard let target, let origin = target.httpsOrigin,
              let request = try? JSONDecoder().decode(PinnedHTTPRequest.self, from: input) else {
            reply(.failure(.invalid)); return
        }
        let tracing = LaunchTrace.begin("http", request.path)
        PinnedHTTP.send(origin: origin, pin: target.pin, request: request, now: services.now) { result in
            tracing.end()
            callback.finish()
            reply(result)
        }
    }
    private func socket(_ id: String, action: String, text: String) {
        switch action {
        case "open":
            let runtime = runtime
            guard let target else {
                runtime?.execute { context in context.objectForKeyedSubscript("aceSocket")?.call(withArguments: [id, "close", "4003"]) }
                return
            }
            let socket = PinnedSocket(target: target, now: services.now, streams: runtime?.browserStreams) { type, value in
                runtime?.execute { context in
                    // Binary messages reach the SDK as a Uint8Array, never as text to unpack in script.
                    let payload: Any = type == "binary"
                        ? (Data(base64Encoded: value) ?? Data()).withUnsafeBytes { NativeBytes.makeArray($0, in: context) }
                        : value
                    HostTrace.measure("js.socket") { _ = context.objectForKeyedSubscript("aceSocket")?.call(withArguments: [id, type, payload]) }
                }
            }
            sockets[id] = socket
            socket.open()
        case "send": sockets[id]?.send(text)
        case "close": sockets.removeValue(forKey: id)?.close()
        default: break
        }
    }
    private func setTimer(_ id: String, delay: Double, callback: Callback) {
        guard delay.isFinite, delay >= 0, timers.count < 4096 else { return }
        let timer = Timer(timeInterval: delay / 1000, repeats: false) { [weak self] _ in
            self?.timers.removeValue(forKey: id)
            HostTrace.measure("js.timer") { _ = callback.value.call(withArguments: []) }
        }
        timers[id] = timer
        RunLoop.current.add(timer, forMode: .default)
    }
    func close() {
        for socket in sockets.values { socket.close() }
        sockets.removeAll()
        for timer in timers.values { timer.invalidate() }
        timers.removeAll()
        storageQueue.sync { store = nil }
    }
}
