import Foundation

/// Where New thread's draft files are read and written: one serial queue off the main thread.
/// Writes queue up in order; a read waits for the writes queued before it, so whoever reads the
/// draft (the next sheet, a handoff, a relaunch) sees the last one saved.
final class NewThreadDraftWriter: @unchecked Sendable {
    /// The app's one writer, so every store over the same files shares its order.
    static let shared = NewThreadDraftWriter()
    private let queue = DispatchQueue(label: "dev.acehq.new-thread-draft", qos: .userInitiated)
    /// Draft writes that reached the disk; only touched on `queue`.
    private var count = 0

    /// Runs `work` on the queue after every write queued before it, and waits for its result.
    func run<T>(_ work: () -> T) -> T { queue.sync(execute: work) }
    /// Queues a write of the draft file; the caller doesn't wait for it.
    func write(_ work: @escaping @Sendable () -> Void) {
        queue.async { [self] in work(); count += 1 }
    }
    /// Returns once every queued write is on disk.
    func settle() { queue.sync {} }
    /// How many draft writes reached the disk so far.
    var writes: Int { queue.sync { count } }
}

/// Runs a save once typing pauses. Injected, so tests decide when the pause ends.
@MainActor protocol DraftSaveTimer: AnyObject {
    /// `save` runs once the pause passes with no newer call; a newer call or `cancel` replaces it.
    func schedule(_ save: @escaping @MainActor () -> Void)
    func cancel()
}

/// The app's pause: a short wait after the last keystroke.
@MainActor final class DraftPauseTimer: DraftSaveTimer {
    private let delay: Duration
    private var pending: Task<Void, Never>?
    init(delay: Duration = .milliseconds(300)) { self.delay = delay }
    func schedule(_ save: @escaping @MainActor () -> Void) {
        pending?.cancel()
        let delay = delay
        pending = Task { @MainActor in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            save()
        }
    }
    func cancel() {
        pending?.cancel()
        pending = nil
    }
}

enum NewThreadDraftChange {
    /// Only the words moved (and the references riding on them): typing, which is saved once it
    /// pauses. Anything else, including a typed edit that stops a handoff starting by itself or
    /// drops a reserved command, is saved at once.
    static func isTyping(from old: NewThreadDraft, to new: NewThreadDraft) -> Bool {
        guard old.text != new.text || old.picks != new.picks else { return false }
        var before = old, after = new
        before.text = ""; after.text = ""
        before.picks = nil; after.picks = nil
        return before == after
    }
}
