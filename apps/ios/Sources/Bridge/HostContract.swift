import Foundation
import JavaScriptCore
import Security

/// The iPhone's side of the native host contract (`@ace/native-host`, ADR 0096). These are the
/// stateless capabilities; `NativeHost` adds timers, async operations, frames and sockets, which
/// belong to one runtime. Every function runs on the runtime's JavaScript thread.
enum HostContract {
    /// The contract version this host implements (`HOST_CONTRACT_VERSION`).
    static let version = 1
    /// Optional capabilities this host offers.
    static let capabilities = ["inflate", "trace"]

    /// Clock, ids, entropy, text, bytes and URL parsing, as `aceHost` members.
    static func stateless() -> [String: Any] {
        let now: @convention(block) () -> Double = { Date().timeIntervalSince1970 * 1000 }
        let uuid: @convention(block) () -> String = { UUID().uuidString.lowercased() }
        let random: @convention(block) () -> Double = { Double(UInt32.random(in: .min ... .max)) / 4294967296 }
        let randomBytes: @convention(block) (Int) -> JSValue = { count in
            guard let context = JSContext.current() else { return JSValue() }
            var bytes = [UInt8](repeating: 0, count: max(0, min(count, 65536)))
            guard count >= 0, count <= 65536, SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
                context.exception = JSValue(newErrorFromMessage: "Entropy unavailable", in: context)
                return JSValue(undefinedIn: context)
            }
            return bytes.withUnsafeBytes { NativeBytes.makeArray($0, in: context) }
        }
        // Counted without making the bytes: the pump sizes every patch before it sends it.
        let utf8Length: @convention(block) (String) -> Int = { text in HostTrace.measure("host.utf8Length") { text.utf8.count } }
        let previewHead: @convention(block) (String, Int) -> String = { text, limit in HostTrace.measure("host.preview") { DisplayText.head(text, limit: limit) } }
        let previewTail: @convention(block) (String, Int) -> String = { text, limit in HostTrace.measure("host.preview") { DisplayText.tail(text, limit: limit) } }
        let latin1Base64: @convention(block) (String, Bool) -> String = { text, decode in
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
        // Spans the script times itself, totalled with the native ones (`HostTrace`).
        let trace: @convention(block) (String, Double, Double) -> Void = { name, ms, bytes in
            HostTrace.add("js:" + name, seconds: ms / 1000, bytes: Int(bytes))
        }
        let functions: [String: Any] = [
            "now": now, "uuid": uuid, "random": random, "randomBytes": randomBytes, "utf8Length": utf8Length,
            "previewHead": previewHead, "previewTail": previewTail, "latin1Base64": latin1Base64,
            "parseURL": parseURL, "trace": trace,
        ]
        return functions.merging(NativeBytes.functions()) { current, _ in current }
    }

    /// Installs `members` as `aceHost` with this host's version and capabilities.
    static func install(_ members: [String: Any], in context: JSContext) {
        context.setObject(members, forKeyedSubscript: "aceHost" as NSString)
        let host = context.objectForKeyedSubscript("aceHost")
        host?.setObject(version, forKeyedSubscript: "version" as NSString)
        host?.setObject(capabilities, forKeyedSubscript: "capabilities" as NSString)
        host?.setObject(HostTrace.enabled, forKeyedSubscript: "tracing" as NSString)
    }
}

/// One async host operation: its JSON `input` and its text `body`, which travels unescaped.
struct HostRequest: Sendable {
    let operation: String
    let input: Data
    let body: String?
    init(_ operation: String, input: Data = Data("null".utf8), body: String? = nil) {
        self.operation = operation; self.input = input; self.body = body
    }
    /// The body, which this operation requires.
    func requireBody() throws -> String {
        guard let body else { throw HostError.storage }
        return body
    }
}

extension HostError {
    /// The contract's error code for a failed operation (`HostErrorCode`).
    static func code(of error: any Error) -> String {
        switch error as? HostError {
        case .storage: "storage"
        case .identity: "identity"
        case .unsupported: "unsupported"
        default: "failed"
        }
    }
}
