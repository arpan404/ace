import Foundation

/// Computer-use mode speaks JSON lines on stdin/stdout: `{id, op, ...}` in,
/// `{id, ok, result}` or `{id, ok:false, error:{code, message}}` out.
/// Messages are written for the model: they say what happened and what to do next.
struct CUError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

typealias CUObject = [String: Any]

final class CUOutput: @unchecked Sendable {
    static let shared = CUOutput()
    private let lock = NSLock()
    func send(_ object: CUObject) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else { return }
        lock.lock(); defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
    func reply(_ id: String, result: CUObject) { send(["id": id, "ok": true, "result": result]) }
    func reply(_ id: String, error: Error) {
        let failure = error as? CUError ?? CUError("internal", String(describing: error))
        send(["id": id, "ok": false, "error": ["code": failure.code, "message": failure.message]])
    }
}

extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) -> String? { self[key] as? String }
    func int(_ key: String) -> Int? { (self[key] as? NSNumber)?.intValue }
    func double(_ key: String) -> Double? { (self[key] as? NSNumber)?.doubleValue }
    func bool(_ key: String) -> Bool? { (self[key] as? NSNumber)?.boolValue }
    func objects(_ key: String) -> [CUObject] { self[key] as? [CUObject] ?? [] }
    func strings(_ key: String) -> [String] { self[key] as? [String] ?? [] }
}
