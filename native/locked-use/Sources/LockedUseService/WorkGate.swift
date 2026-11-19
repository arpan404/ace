import LockedUseCore

/// The approved work for one attempt: it stays open until the daemon says the turn's
/// computer-use work is finished, or until the coordinator cancels it.
@MainActor public final class LockedUseWorkGate {
    private var attempt: String?
    private var finished = false
    private var waiter: CheckedContinuation<Void, Error>?

    public init() {}

    public func work(for attempt: String) -> @MainActor () async throws -> Void {
        self.attempt = attempt
        finished = false
        return { [weak self] in
            guard let self else { throw CancellationError() }
            try await self.wait(attempt)
        }
    }

    /// Returns false if `attempt` is not the open attempt.
    public func finish(_ attempt: String) -> Bool {
        guard self.attempt == attempt else { return false }
        finished = true
        waiter?.resume()
        waiter = nil
        return true
    }

    public func cancel(_ attempt: String) {
        guard self.attempt == attempt else { return }
        waiter?.resume(throwing: CancellationError())
        waiter = nil
        self.attempt = nil
    }

    private func wait(_ attempt: String) async throws {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if finished || self.attempt != attempt || Task.isCancelled {
                    continuation.resume(with: finished && self.attempt == attempt ? .success(()) : .failure(CancellationError()))
                } else {
                    waiter = continuation
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel(attempt) }
        }
    }
}
