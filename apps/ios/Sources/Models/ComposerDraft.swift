import Observation
import Foundation

@MainActor @Observable final class ComposerDraft {
    var text = "" { didSet { if text != oldValue { textChanged() } } }
    private(set) var saving = false
    @ObservationIgnored private var store: ThreadDrafts?
    @ObservationIgnored private var key: String?
    @ObservationIgnored private var pendingSave: Task<Void, Never>?
    @ObservationIgnored private let saveDelay: Duration

    init(saveDelay: Duration = .milliseconds(300)) { self.saveDelay = saveDelay }

    /// Follow `key`'s saved words in `store`: the composer shows them and keeps them as they change.
    /// The draft it followed before is saved first.
    func follow(_ key: String?, in store: ThreadDrafts?) {
        guard key != self.key || store !== self.store else { return }
        flush()
        self.store = store
        self.key = key
        text = key.flatMap { store?.text(for: $0) } ?? ""
    }
    /// Save what is typed now, without waiting for typing to pause.
    func flush() {
        pendingSave?.cancel()
        pendingSave = nil
        if let store, let key { store.save(text, for: key) }
    }

    /// `files` counts what the message carries besides words: a message of only files can go.
    func submit(delivery: String, files: Int = 0, persist: (String, String) async -> Bool) async {
        guard !saving, files > 0 || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let submittedText = text
        saving = true
        defer { saving = false }
        if await persist(submittedText, delivery), text == submittedText { text = "" }
    }

    /// Typing saves once it pauses; an emptied composer (a sent message) saves at once, so a
    /// relaunch never offers words that already went.
    private func textChanged() {
        guard let store, let key else { return }
        pendingSave?.cancel()
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            pendingSave = nil
            store.save(text, for: key)
            return
        }
        let delay = saveDelay
        pendingSave = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            self.pendingSave = nil
            store.save(self.text, for: key)
        }
    }
}
