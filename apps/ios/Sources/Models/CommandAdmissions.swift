import Foundation

/// Correlates local UI requests. Protocol command IDs and admission remain in the SDK.
@MainActor final class CommandAdmissions {
    private var sequence = 0
    private var waiting: [String: CheckedContinuation<Bool, Never>] = [:]
    func nextId() -> String { sequence += 1; return String(sequence) }
    func wait(id: String, dispatch: () -> Bool) async -> Bool {
        await withCheckedContinuation { continuation in
            waiting[id] = continuation
            if !dispatch() { resolve(id, persisted: false) }
        }
    }
    func resolve(_ id: String, persisted: Bool) { waiting.removeValue(forKey: id)?.resume(returning: persisted) }
    func cancel() {
        let pending = waiting.values
        waiting = [:]
        for continuation in pending { continuation.resume(returning: false) }
    }
}
