import Foundation

struct ReviewReplyDraft {
    var text = ""
    private(set) var request: String?
    private(set) var pending = false
    private var submitted = ""

    /// Written out: a private stored property makes the memberwise initializer private too.
    init(text: String = "") { self.text = text }

    var tooLong: Bool { text.utf16.count > 4096 }
    var canSubmit: Bool { !pending && !tooLong && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    mutating func begin(id: String) {
        request = id
        submitted = text
        pending = true
    }

    mutating func finish(ok: Bool) {
        if ok && text == submitted { text = "" }
        pending = false
    }
}
