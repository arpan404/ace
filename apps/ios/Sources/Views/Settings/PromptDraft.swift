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

/// The prompt operation that failed, so Retry repeats exactly that one.
enum PromptFailure: Equatable {
    case read, reload, save
    /// The machine's copy changed under this draft. Sending the old revision again can never land,
    /// so the editor offers Reload from machine instead of Retry.
    case conflict

    /// What Retry sends again, or nil when only a reload can recover.
    var retry: PromptFailure? { self == .conflict ? nil : self }
}
