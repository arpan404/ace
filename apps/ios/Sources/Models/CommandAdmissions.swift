import Foundation

/// What became of a request: saved on the machine, definitely not (refused, or never reached the
/// bridge), or unknown (the runtime went before it answered, and it may have been saved).
enum AdmissionOutcome: Sendable, Equatable { case saved, refused, unknown }

/// Correlates local UI requests. Protocol command IDs and admission remain in the SDK.
@MainActor final class CommandAdmissions {
    private var sequence = 0
    private var waiting: [String: CheckedContinuation<AdmissionOutcome, Never>] = [:]
    func nextId() -> String { sequence += 1; return String(sequence) }
    /// True once saved; a refusal and an unknown outcome are both false.
    func wait(id: String, dispatch: () -> Bool) async -> Bool { await outcome(id: id, dispatch: dispatch) == .saved }
    func outcome(id: String, dispatch: () -> Bool) async -> AdmissionOutcome {
        await withCheckedContinuation { continuation in
            waiting[id] = continuation
            if !dispatch() { resolve(id, .refused) }
        }
    }
    func resolve(_ id: String, persisted: Bool) { resolve(id, persisted ? .saved : .refused) }
    private func resolve(_ id: String, _ outcome: AdmissionOutcome) { waiting.removeValue(forKey: id)?.resume(returning: outcome) }
    /// The runtime went: every waiter's request may or may not have been saved.
    func cancel() {
        let pending = waiting.values
        waiting = [:]
        for continuation in pending { continuation.resume(returning: .unknown) }
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

/// The last answer to a bulk action that went out with threads still waiting on the machine
/// (`inbox.bulk.final`), by the phone's ticket. One that arrives before anyone waits is kept
/// for them; closing the connection answers every waiter with nil, and they stay pending.
@MainActor final class BulkFinals {
    private var waiting: [String: CheckedContinuation<BulkOutcome?, Never>] = [:]
    private var arrived: [String: BulkOutcome] = [:]
    func wait(_ ticket: String) async -> BulkOutcome? {
        if let outcome = arrived.removeValue(forKey: ticket) { return outcome }
        return await withCheckedContinuation { waiting[ticket] = $0 }
    }
    func resolve(_ ticket: String, _ outcome: BulkOutcome) {
        if let continuation = waiting.removeValue(forKey: ticket) { continuation.resume(returning: outcome) }
        else { arrived[ticket] = outcome }
    }
    func cancel() {
        let pending = waiting.values
        waiting = [:]
        arrived = [:]
        for continuation in pending { continuation.resume(returning: nil) }
    }
}
