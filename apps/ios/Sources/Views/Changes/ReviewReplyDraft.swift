import Foundation

struct ReviewReplyDraft {
    var text = ""
    private(set) var request: String?
    private(set) var pending = false
    private var submitted = ""

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
