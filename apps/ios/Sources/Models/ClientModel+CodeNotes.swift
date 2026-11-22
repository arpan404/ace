import Foundation

/// The editor's code notes (`CodeNotes`): each change is made here at once, then the open thread's
/// bridge session is handed the thread's whole list (`code.set`, `bridge/thread-code-notes.ts`),
/// which Send turns into one `<code_annotations>` block after the words.
extension ClientModel {
    /// A new note on `span` of `path` in `thread`, whose text is `lines`; nil once the thread is full.
    @discardableResult
    func addCodeNote(_ thread: String, path: String, span: TextSpan, lines: [String], comment: String) -> String? {
        guard canOperate, !codeNotes.full(thread) else { return nil }
        let id = UUID().uuidString
        codeNotes.add(thread, path: path, span: span, lines: lines, comment: comment, id: id)
        sendCodeNotes(thread)
        return id
    }
    func commentCodeNote(_ thread: String, id: String, _ comment: String) {
        codeNotes.comment(thread, id: id, comment)
        sendCodeNotes(thread)
    }
    func removeCodeNote(_ thread: String, id: String) {
        codeNotes.remove(thread, id: id)
        sendCodeNotes(thread)
    }
    func clearCodeNotes(_ thread: String) {
        codeNotes.clear(thread)
        sendCodeNotes(thread)
    }
    /// The person typed in `path`: its notes move with the edit (`line` reads the text after it).
    func codeEdited(_ thread: String, path: String, through replacements: [TextReplacement], line: (Int) -> String) {
        let before = codeNotes
        codeNotes.edited(thread, path: path, through: replacements, line: line)
        if codeNotes != before { sendCodeNotes(thread) }
    }
    /// `path`'s editor loaded new text (an agent's change, a discarded edit, the file at open).
    func codeReloaded(_ thread: String, path: String, before lines: [String]?, after: [String]) {
        let before = codeNotes
        codeNotes.reloaded(thread, path: path, before: lines, after: after)
        if codeNotes != before { sendCodeNotes(thread) }
    }
    /// A file moved or was renamed: its notes follow.
    func codeRenamed(from path: String, to destination: String) {
        let before = codeNotes
        codeNotes.renamed(from: path, to: destination)
        if codeNotes != before, let open = thread?.id { sendCodeNotes(open) }
    }
    /// The open thread's session hears `thread`'s notes; another thread's wait until it opens.
    func sendCodeNotes(_ thread: String) {
        guard canOperate, self.thread?.id == thread else { return }
        threadAction(["type": "code.set", "notes": codeNotes.wire(thread)])
    }
}
