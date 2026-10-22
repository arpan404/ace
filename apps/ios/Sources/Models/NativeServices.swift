import Foundation
import os

/// Service reads as signpost intervals and log lines, so each screen's wait is measurable.
let serviceSignposter = OSSignposter(subsystem: "app.ace.ios", category: "service")
let serviceLog = Logger(subsystem: "app.ace.ios", category: "service")

/// Schema-validated SDK service replies. Each screen decodes the fields it uses into its DTO.
indirect enum ServiceValue: Codable, Sendable {
    case object([String: ServiceValue]), array([ServiceValue]), string(String), number(Double), bool(Bool), null
    init(from decoder: any Decoder) throws {
        let box = try decoder.singleValueContainer()
        if box.decodeNil() { self = .null }
        else if let value = try? box.decode(Bool.self) { self = .bool(value) }
        else if let value = try? box.decode(Double.self) { self = .number(value) }
        else if let value = try? box.decode(String.self) { self = .string(value) }
        else if let value = try? box.decode([ServiceValue].self) { self = .array(value) }
        else { self = .object(try box.decode([String: ServiceValue].self)) }
    }
    func encode(to encoder: any Encoder) throws {
        var box = encoder.singleValueContainer()
        switch self {
        case .object(let value): try box.encode(value)
        case .array(let value): try box.encode(value)
        case .string(let value): try box.encode(value)
        case .number(let value): try box.encode(value)
        case .bool(let value): try box.encode(value)
        case .null: try box.encodeNil()
        }
    }
    func decode<T: Decodable>(_ type: T.Type) throws -> T { try JSONDecoder().decode(type, from: JSONEncoder().encode(self)) }
}
struct ServiceReply: Decodable, Sendable {
    /// Names a kept read's answer (`bridge/native-reads.ts`).
    struct Cache: Decodable, Sendable { let key: String; let family: String }
    let id: String
    let ok: Bool
    let value: ServiceValue?
    let message: String
    var cache: Cache?
}
struct ServiceFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@MainActor final class NativeServiceCalls {
    private var waiting: [String: CheckedContinuation<ServiceValue, any Error>] = [:]
    func wait(id: String, dispatch: () -> Bool) async throws -> ServiceValue {
        try Task.checkCancellation()
        return try await withCheckedThrowingContinuation { continuation in
            waiting[id] = continuation
            if !dispatch() { fail(id, message: "Machine disconnected. Retry when connected.") }
        }
    }
    func receive(_ reply: ServiceReply) {
        guard let continuation = waiting.removeValue(forKey: reply.id) else { return }
        if reply.ok, let value = reply.value { continuation.resume(returning: value) }
        else { continuation.resume(throwing: ServiceFailure(message: reply.message)) }
    }
    func fail(_ id: String, message: String) { waiting.removeValue(forKey: id)?.resume(throwing: ServiceFailure(message: message)) }
    func cancel() {
        let pending = waiting
        waiting = [:]
        for continuation in pending.values { continuation.resume(throwing: CancellationError()) }
    }
}

extension ClientModel {
    func service<T: Decodable>(_ payload: [String: Any], as type: T.Type) async throws -> T {
        try await call(payload, cache: nil, as: type)
    }
    /// A read the bridge keeps (`bridge/read-policy.ts`): asked like `service`, answered from
    /// the bridge's cache while fresh, and copied into `reads` for the next visit's first frame.
    func read<T: Decodable>(_ payload: [String: Any], as type: T.Type) async throws -> T {
        try await call(payload, cache: ReadMirror.key(payload), as: type)
    }
    /// The last kept answer to `payload`, for drawing before the read finishes.
    func kept<T: Decodable>(_ payload: [String: Any], as type: T.Type) -> T? {
        ReadMirror.key(payload).flatMap { reads.value($0, as: type) }
    }
    /// Moves when the kept answer to `payload` goes out of date; a screen reads it again.
    func readGeneration(_ payload: [String: Any]) -> Int {
        ReadMirror.key(payload).map { reads.generation($0) } ?? 0
    }
    private func call<T: Decodable>(_ payload: [String: Any], cache: String?, as type: T.Type) async throws -> T {
        let id = "native-\(admissions.nextId())"
        let name = serviceName(payload)
        let interval = serviceSignposter.beginInterval("service", id: serviceSignposter.makeSignpostID(), "\(name, privacy: .public)")
        let started = ContinuousClock.now
        defer {
            serviceSignposter.endInterval("service", interval)
            serviceLog.info("service \(name, privacy: .public) \((ContinuousClock.now - started).components.attoseconds / 1_000_000_000_000_000 + (ContinuousClock.now - started).components.seconds * 1000, privacy: .public)ms")
        }
        // The SDK bounds network waits. This also bounds native decoding/delivery failures.
        let deadline = Task { @MainActor in
            do { try await Task.sleep(for: .seconds(30)) } catch { return }
            services.fail(id, message: "The request timed out. Your input is still available; retry when connected.")
            action(["type": "service.cancel", "id": id])
        }
        defer { deadline.cancel() }
        let value = try await withTaskCancellationHandler {
            try await services.wait(id: id) {
                var message: [String: Any] = ["type": "service", "id": id, "request": payload]
                if let cache { message["cache"] = cache }
                return action(message)
            }
        } onCancel: {
            Task { @MainActor in
                self.services.fail(id, message: "Request cancelled")
                self.action(["type": "service.cancel", "id": id])
            }
        }
        try Task.checkCancellation()
        return try value.decode(type)
    }
}

/// The request's type and operation, for timing logs.
func serviceName(_ payload: [String: Any]) -> String {
    let type = payload["type"] as? String ?? "?"
    if let operation = payload["operation"] as? [String: Any], let op = operation["op"] as? String { return "\(type)/\(op)" }
    return type
}
