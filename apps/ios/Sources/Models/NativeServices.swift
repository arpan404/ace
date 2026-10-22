import Foundation

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
    let id: String
    let ok: Bool
    let value: ServiceValue?
    let message: String
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
    /// `timeout` bounds the wait; a start in the machine's sharing dialog waits for the person there.
    func service<T: Decodable>(_ payload: [String: Any], as type: T.Type, timeout: Duration = .seconds(30)) async throws -> T {
        let id = "native-\(admissions.nextId())"
        // The SDK bounds network waits. This also bounds native decoding/delivery failures.
        let deadline = Task { @MainActor in
            do { try await Task.sleep(for: timeout) } catch { return }
            services.fail(id, message: "The request timed out. Your input is still available; retry when connected.")
            action(["type": "service.cancel", "id": id])
        }
        defer { deadline.cancel() }
        let value = try await withTaskCancellationHandler {
            try await services.wait(id: id) { action(["type": "service", "id": id, "request": payload]) }
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
