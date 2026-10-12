import Observation
import Foundation

@MainActor @Observable final class ComposerDraft {
    var text = ""
    private(set) var saving = false
    func submit(delivery: String, persist: (String, String) async -> Bool) async {
        guard !saving, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let submittedText = text
        saving = true
        defer { saving = false }
        if await persist(submittedText, delivery), text == submittedText { text = "" }
    }
}
