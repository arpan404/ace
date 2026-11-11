/// A prompt draft retains the revision its edits started from across reconnects.
struct PromptDraft {
    var text = ""
    private(set) var baseline = ""
    private(set) var revision: String?
    private(set) var reloadAvailable = false
    var dirty: Bool { text != baseline }

    mutating func receive(text: String, revision: String) {
        guard !dirty else { reloadAvailable = true; return }
        self.text = text
        baseline = text
        self.revision = revision
    }

    mutating func saved(text: String, revision: String?) {
        baseline = text
        self.revision = revision
        reloadAvailable = false
    }
}
