import Foundation

/// Lets heavy rendering for one view run only while the view is on screen. A finished answer's
/// markit view goes on the thread's shelf when its row scrolls away, still waiting for its
/// diagrams; closing its gate pulls those requests out of the drawing queue (their work is
/// cancelled) without answering markit, which asks once per diagram, and opening it again asks
/// afresh. A request whose own task is cancelled (markit discarded the view) stops waiting.
@MainActor final class RenderGate {
    private(set) var isOpen = true
    private var nextId = 0
    /// Requests waiting for the gate to open.
    private var waiting: [Int: CheckedContinuation<Void, Never>] = [:]
    /// Cancels the work of each request running now.
    private var running: [Int: () -> Void] = [:]

    /// The work's result, run while the gate is open. Work cut short by the gate closing (nil
    /// while closed) runs again once it opens; nil when the request itself was cancelled.
    func run<Result: Sendable>(_ work: @escaping @MainActor () async -> Result?) async -> Result? {
        while !Task.isCancelled {
            guard isOpen else {
                await opened()
                continue
            }
            let id = take()
            let task = Task { @MainActor in await work() }
            running[id] = { task.cancel() }
            let result = await withTaskCancellationHandler {
                await task.value
            } onCancel: {
                task.cancel()
            }
            running[id] = nil
            if result != nil || isOpen || Task.isCancelled { return result }
        }
        return nil
    }

    func open() {
        guard !isOpen else { return }
        isOpen = true
        let resumed = waiting
        waiting = [:]
        for continuation in resumed.values { continuation.resume() }
    }

    func close() {
        guard isOpen else { return }
        isOpen = false
        for cancel in running.values { cancel() }
    }

    private func opened() async {
        let id = take()
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                if isOpen || Task.isCancelled { continuation.resume() } else { waiting[id] = continuation }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.waiting.removeValue(forKey: id)?.resume() }
        }
    }

    private func take() -> Int {
        nextId += 1
        return nextId
    }
}
