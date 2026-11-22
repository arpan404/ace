import Foundation

/// The editor's code notes (`CodeNotes`): each change is made here at once, then the open thread's
/// bridge session is handed the thread's whole list (`code.set`, `bridge/thread-code-notes.ts`),
/// which Send turns into one `<code_annotations>` block after the words.
extension ClientModel {
    /// A new note on `span` of `path` in `thread`, whose text is `lines`; nil once the thread is full.
    /// `now` is the file's text as the note is added, when it may have changed since `lines`.
    @discardableResult
    func addCodeNote(_ thread: String, path: String, span: TextSpan, lines: [String], now: [String]? = nil, comment: String) -> String? {
        guard canOperate, !codeNotes.full(thread) else { return nil }
        let id = UUID().uuidString
        codeNotes.add(thread, path: path, span: span, lines: lines, now: now, comment: comment, id: id, checkout: checkoutKeys[thread])
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
    /// A file moved or was renamed in `scope`'s checkout: the notes made in that checkout follow.
    func codeRenamed(_ scope: FilesScope, from path: String, to destination: String) async {
        guard case .thread(let renaming) = scope else { return }
        let checkout = await checkoutKey(renaming)
        let before = codeNotes
        codeNotes.renamed(in: checkout, thread: renaming, from: path, to: destination)
        if codeNotes != before, let open = thread?.id { sendCodeNotes(open) }
    }
    /// A thread's checkout as notes name it, this machine and the checkout's root; read once, nil
    /// while the root can't be read.
    @discardableResult
    func checkoutKey(_ thread: String) async -> String? {
        if let known = checkoutKeys[thread] { return known }
        guard let found = try? await files(.thread(thread), ["op": "root"], as: CheckoutRoot.self, timeout: .seconds(3)),
              let root = found.root else { return nil }
        let key = "\(hostId ?? "")\u{0}\(root)"
        checkoutKeys[thread] = key
        return key
    }
    /// The open thread's session hears `thread`'s notes; another thread's wait until it opens.
    func sendCodeNotes(_ thread: String) {
        guard canOperate, self.thread?.id == thread else { return }
        threadAction(["type": "code.set", "notes": codeNotes.wire(thread)])
    }
}

private struct CheckoutRoot: Decodable { let root: String? }
