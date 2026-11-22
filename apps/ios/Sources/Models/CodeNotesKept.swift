import CryptoKit
import Foundation

/// One signed-in principal's code notes on one machine (`CodeNotes`), kept on this phone so a
/// relaunch gives back the notes waiting on each thread's next message. A change the person is
/// told about (a note made, its words changed, one removed, a message that took some) is written
/// at once (`save`); a burst of moves while typing is written once, `delay` after its first
/// (`changed`). A write that fails is kept and tried again, waiting twice as long each time up
/// to `retryCap`, so a later success writes the newest notes.
@MainActor final class CodeNotesKept {
    private let file: DraftFile<CodeNotes>
    private let delay: Duration
    private let retryCap: Duration
    private var retry: Duration
    private var unsaved: CodeNotes?
    private var saving: Task<Void, Never>?

    init(url: URL, delay: Duration = .milliseconds(500), retryCap: Duration = .seconds(30)) {
        file = DraftFile(url: url)
        self.delay = delay
        self.retryCap = retryCap
        retry = delay
    }

    /// Where one principal's notes on one machine are kept (`ConnectionTarget.keptScope`, which
    /// names both): an account machine's device id is this install's for every account, so host
    /// and device alone would hand one account's notes to another.
    nonisolated static func url(keptScope: String, in directory: URL) -> URL {
        let name = SHA256.hash(data: Data(keptScope.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(name + ".code-notes.json")
    }

    /// What was kept; none when nothing was, or it can't be read.
    func load() -> CodeNotes { file.load() ?? CodeNotes() }

    /// A burst of changes: written once it settles.
    func changed(_ notes: CodeNotes) {
        unsaved = notes
        schedule(after: delay)
    }

    /// Written now; false when the write failed (it is tried again).
    @discardableResult func save(_ notes: CodeNotes) -> Bool {
        unsaved = notes
        return flush()
    }

    /// Whatever waits is written now; false when the write failed (it is tried again).
    @discardableResult func flush() -> Bool {
        saving?.cancel()
        saving = nil
        guard let notes = unsaved else { return true }
        do {
            try file.save(notes)
            unsaved = nil
            retry = delay
            return true
        } catch {
            schedule(after: retry)
            retry = min(retry * 2, retryCap)
            return false
        }
    }

    private func schedule(after wait: Duration) {
        guard saving == nil else { return }
        saving = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard !Task.isCancelled, let self else { return }
            self.saving = nil
            self.flush()
        }
    }
}
