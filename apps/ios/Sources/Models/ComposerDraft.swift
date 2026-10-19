import Observation
import Foundation

@MainActor @Observable final class ComposerDraft {
    var text = ""
    private(set) var saving = false
    /// `files` counts what the message carries besides words: a message of only files can go.
    func submit(delivery: String, files: Int = 0, persist: (String, String) async -> Bool) async {
        guard !saving, files > 0 || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let submittedText = text
        saving = true
        defer { saving = false }
        if await persist(submittedText, delivery), text == submittedText { text = "" }
    }
}
