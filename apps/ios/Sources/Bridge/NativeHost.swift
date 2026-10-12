import Foundation
import JavaScriptCore
import Security

/// All mutable dictionaries live on ClientRuntime's thread. Disk work has its own serial queue.
final class NativeHost: @unchecked Sendable {
    private weak var runtime: ClientRuntime?
    private let target: ConnectionTarget
    private let storageURL: URL
    private let receive: @Sendable (Data) -> Void
    private let storageQueue = DispatchQueue(label: "ace.client.storage", qos: .utility)
    private var store: DurableStore?
    private var sockets: [String: PinnedSocket] = [:]
    private var timers: [String: Timer] = [:]

    init(runtime: ClientRuntime, target: ConnectionTarget, storageURL: URL, receive: @escaping @Sendable (Data) -> Void) {
        self.runtime = runtime; self.target = target; self.storageURL = storageURL; self.receive = receive
    }
    func install(in context: JSContext) {
        let call: @convention(block) (String, String, JSValue) -> Void = { [weak self] operation, json, value in
            self?.call(operation, json: json, callback: Callback(value))
        }
        let emit: @convention(block) (String) -> Void = { [weak self] json in
            guard let data = json.data(using: .utf8), data.count <= 32768 else { return }
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
        let encode: @convention(block) (String) -> [UInt8] = { Array($0.utf8) }
        let decode: @convention(block) ([UInt8], String, Bool) -> String = { bytes, encoding, fatal in
            let data = Data(bytes)
            let selected: String.Encoding = encoding.lowercased() == "utf-16le" ? .utf16LittleEndian : .utf8
            if let text = String(data: data, encoding: selected) { return text }
            if fatal { JSContext.current()?.exception = JSValue(newErrorFromMessage: "Invalid encoded text", in: JSContext.current()) }
            return String(decoding: bytes, as: UTF8.self)
        }
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
        let functions: [String: Any] = ["call": call, "emit": emit, "socket": socket, "timer": timer,
            "cancelTimer": cancel, "now": now, "uuid": uuid, "random": random, "encode": encode,
            "decode": decode, "randomBytes": entropy, "base64": base64]
        context.setObject(functions, forKeyedSubscript: "aceHost" as NSString)
    }
    private func call(_ operation: String, json: String, callback: Callback) {
        storageQueue.async { [self] in
            let result: Result<String, Error> = Result {
                if operation == "credential" { return try target.credential() }
                if store == nil { store = try DurableStore(url: storageURL) }
                guard let store, let data = json.data(using: .utf8), data.count <= 9 * 1024 * 1024 else { throw HostError.storage }
                return try store.perform(operation, input: data)
            }
            runtime?.execute { _ in
                switch result {
                case .success(let text): callback.value.call(withArguments: [NSNull(), text])
                case .failure: callback.value.call(withArguments: ["Host operation failed", ""])
                }
            }
        }
    }
    private func socket(_ id: String, action: String, text: String) {
        switch action {
        case "open":
            let runtime = runtime
            let socket = PinnedSocket(target: target) { type, value in
                runtime?.execute { context in
                    context.objectForKeyedSubscript("aceSocket")?.call(withArguments: [id, type, value])
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
            callback.value.call(withArguments: [])
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
