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

/// Requests for a message's full words (`words` patches): resolves with the words, or nil and why.
@MainActor final class WordsRequests {
    struct Answer: Sendable, Equatable {
        var ok: Bool = true
        let text: String?
        let message: String
        /// The queue revision the words were read at; nil for a send in the outbox.
        var revision: Int? = nil
    }
    nonisolated static let unsent = Answer(ok: false, text: nil, message: "Couldn't reach the bridge. Try again.")
    private var waiting: [String: CheckedContinuation<Answer, Never>] = [:]
    func wait(id: String, dispatch: () -> Bool) async -> Answer {
        await withCheckedContinuation { continuation in
            waiting[id] = continuation
            if !dispatch() { resolve(id, Self.unsent) }
        }
    }
    func resolve(_ id: String, _ answer: Answer) { waiting.removeValue(forKey: id)?.resume(returning: answer) }
    func cancel() {
        let pending = waiting.values
        waiting = [:]
        for continuation in pending { continuation.resume(returning: Self.unsent) }
    }
}

/// Requests that wait past admission for the daemon's receipt (a goal change): the screen keeps
/// the action pending until the daemon took it or refused it, never just until it was saved on
/// this phone. Resolves with nil when taken, else the refusal's words.
@MainActor final class CommandReceipts {
    private var waiting: [String: CheckedContinuation<String?, Never>] = [:]
    static let unsent = "Couldn't send that to your computer. Try again."
    static let closed = "The connection closed before your computer answered. Try again."
    func wait(id: String, dispatch: () -> Bool) async -> String? {
        await withCheckedContinuation { continuation in
            waiting[id] = continuation
            if !dispatch() { resolve(id, refused: Self.unsent) }
        }
    }
    func tracks(_ id: String) -> Bool { waiting[id] != nil }
    func resolve(_ id: String, refused message: String?) { waiting.removeValue(forKey: id)?.resume(returning: message) }
    func cancel() {
        let pending = waiting.values
        waiting = [:]
        for continuation in pending { continuation.resume(returning: Self.closed) }
    }
}
