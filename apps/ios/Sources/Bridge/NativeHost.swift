import Foundation
import JavaScriptCore
import Security
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
    func install(in context: JSContext) {
        let call: @convention(block) (String, String, JSValue) -> Void = { [weak self] operation, json, value in
            self?.call(operation, json: json, callback: Callback(value))
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
        let now: @convention(block) () -> Double = { Date().timeIntervalSince1970 * 1000 }
        let uuid: @convention(block) () -> String = { UUID().uuidString.lowercased() }
        let random: @convention(block) () -> Double = { Double(UInt32.random(in: .min ... .max)) / 4294967296 }
        let utf8Base64: @convention(block) (String) -> String = { text in HostTrace.measure("host.utf8Base64") { Data(text.utf8).base64EncodedString() } }
        let previewHead: @convention(block) (String, Int) -> String = { DisplayText.head($0, limit: $1) }
        let previewTail: @convention(block) (String, Int) -> String = { DisplayText.tail($0, limit: $1) }
        let entropy: @convention(block) (Int) -> [UInt8] = { count in
            guard count >= 0, count <= 65536 else { return [] }
            var bytes = [UInt8](repeating: 0, count: count)
            guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else {
                JSContext.current()?.exception = JSValue(newErrorFromMessage: "Entropy unavailable", in: JSContext.current())
                return []
            }
            return bytes
        }
        let base64: @convention(block) (String, Bool) -> String = { text, decode in
            if decode {
                guard let data = Data(base64Encoded: text) else { return "" }
                return String(data: data, encoding: .isoLatin1) ?? ""
            }
            return Data(text.unicodeScalars.map { UInt8(truncatingIfNeeded: $0.value) }).base64EncodedString()
        }
        // JavaScriptCore has no WHATWG URL. Foundation parses absolute URLs for the SDK's checks.
        let parseURL: @convention(block) (String) -> String = { text in
            guard let parsed = ParsedURL.parse(text), let data = try? JSONEncoder().encode(parsed) else { return "" }
            return String(decoding: data, as: UTF8.self)
        }
        // Spans the script times itself (`trace(name, ms, bytes)`), totalled with the native ones.
        let trace: @convention(block) (String, Double, Double) -> Void = { name, ms, bytes in
            HostTrace.add("js:" + name, seconds: ms / 1000, bytes: Int(bytes))
        }
        let functions: [String: Any] = ["trace": trace, "parseURL": parseURL, "call": call, "emit": emit, "socket": socket, "timer": timer,
            "cancelTimer": cancel, "now": now, "uuid": uuid, "random": random,
            "randomBytes": entropy, "base64": base64, "utf8Base64": utf8Base64,
            "previewHead": previewHead, "previewTail": previewTail].merging(NativeBytes.functions()) { current, _ in current }
        context.setObject(functions, forKeyedSubscript: "aceHost" as NSString)
        context.objectForKeyedSubscript("aceHost")?.setObject(HostTrace.enabled, forKeyedSubscript: "tracing" as NSString)
    }
    private func call(_ operation: String, json: String, callback: Callback) {
        let began = CACurrentMediaTime()
        let callback = HostTrace.enabled ? Callback(callback.value, traced: operation, began: began) : callback
        if operation == "http" { http(json, callback: callback); return }
        if operation.hasPrefix("snapshot.") { snapshot(operation, json: json, callback: callback); return }
        storageQueue.async { [self] in
            let result: Result<String, Error> = Result {
                guard let data = json.data(using: .utf8), data.count <= 9 * 1024 * 1024 else { throw HostError.storage }
                if operation == "credential" {
                    guard let target, target.isLoopbackFixture else { throw HostError.unsupported }
                    return try target.credential()
                }
                if let value = try services.perform(operation, input: data) { return value }
                guard let storageURL else { throw HostError.unsupported }
                if operation == "inbox.checkpoint" {
                    try InboxCheckpoint.write(try JSONDecoder().decode(String.self, from: data), database: storageURL)
                    return ""
                }
                if store == nil { store = try DurableStore(url: storageURL) }
                guard let store else { throw HostError.storage }
                return try store.perform(operation, input: data)
            }
            reply(result, to: callback)
        }
    }
    private func snapshot(_ operation: String, json: String, callback: Callback) {
        snapshotQueue.async { [self] in
            let result: Result<String, Error> = Result {
                guard let storageURL, let data = json.data(using: .utf8), data.count <= 9 * 1024 * 1024 else { throw HostError.storage }
                if snapshots == nil { snapshots = try SnapshotStore(database: storageURL, now: services.now) }
                guard let value = try snapshots?.perform(operation, input: data) else { throw HostError.unsupported }
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
            case .failure: callback.value.call(withArguments: ["Host operation failed", ""])
            }
        } }
    }
    /// Pinned HTTPS to this runtime's own daemon. Refusals reach the bridge as their reason.
    private func http(_ json: String, callback: Callback) {
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
              let request = try? JSONDecoder().decode(PinnedHTTPRequest.self, from: Data(json.utf8)) else {
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
