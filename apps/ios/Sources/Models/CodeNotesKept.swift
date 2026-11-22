import CryptoKit
import Foundation

/// A machine's code notes kept on this phone (`CodeNotes`), so a relaunch gives back the notes
/// waiting on each thread's next message. A burst of changes (typing moves notes with each key)
/// is written once, `delay` after the first of it; `flush` writes at once.
@MainActor final class CodeNotesKept {
    private let file: DraftFile<CodeNotes>
    private let delay: Duration
    private var unsaved: CodeNotes?
    private var saving: Task<Void, Never>?

    init(url: URL, delay: Duration = .milliseconds(500)) {
        file = DraftFile(url: url)
        self.delay = delay
    }

    /// One machine's notes, beside its cache (`ClientModel.database`): thread ids are only unique
    /// per machine.
    nonisolated static func url(hostId: String, deviceId: String, in directory: URL) -> URL {
        let scope = SHA256.hash(data: Data("\(hostId)\u{0}\(deviceId)".utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(scope + ".code-notes.json")
    }

    /// What was kept; none when nothing was, or it can't be read.
    func load() -> CodeNotes { file.load() ?? CodeNotes() }

    func changed(_ notes: CodeNotes) {
        unsaved = notes
        guard saving == nil else { return }
        let delay = delay
        saving = Task { [weak self] in
            try? await Task.sleep(for: delay)
            self?.flush()
        }
    }

    func flush() {
        saving?.cancel()
        saving = nil
        guard let notes = unsaved else { return }
        unsaved = nil
        try? file.save(notes)
    }
}
