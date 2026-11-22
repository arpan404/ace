import Foundation

/// The editor's code notes (`CodeNotes`): each change is made here at once, then the open thread's
/// bridge session is handed the thread's whole list (`code.set`, `bridge/thread-code-notes.ts`),
/// which Send turns into one `<code_annotations>` block after the words.
extension ClientModel {
    /// A new note on `span` of `path` in `thread`, whose text is `lines`; nil once the thread is full.
    /// `now` is the file's text as the note is added, when it may have changed since `lines`.
    func addCodeNote(_ thread: String, path: String, span: TextSpan, lines: [String], now: [String]? = nil,
                     comment: String) -> Result<String, CodeNoteRefusal> {
        add(thread, comment: comment) { id, checkout in
            codeNotes.add(thread, path: path, span: span, lines: lines, now: now, comment: comment, id: id, checkout: checkout)
        }
    }
    /// A new note on whole new-side lines of a diff of `path` (from line `first`, 1-based).
    func addDiffNote(_ thread: String, path: String, first: Int, texts: [String], comment: String) -> Result<String, CodeNoteRefusal> {
        add(thread, comment: comment) { id, checkout in
            codeNotes.add(thread, path: path, first: first, texts: texts, comment: comment, id: id, checkout: checkout)
        }
    }
    /// A note is confirmed only once it is kept on the phone, so a kill straight after never loses
    /// it; one that can't be kept is taken back, leaving the person their words to try again.
    private func add(_ thread: String, comment: String, _ adding: (String, String?) -> Void) -> Result<String, CodeNoteRefusal> {
        guard canOperate else { return .failure(.cantAct) }
        guard !codeNotes.full(thread) else { return .failure(.full) }
        guard CodeNotes.fits(comment) else { return .failure(.tooLong) }
        let before = codeNotes
        let id = UUID().uuidString
        adding(id, checkoutKeys[thread])
        guard codeNotes.number(thread, id: id) != nil else { return .failure(.noCode) }
        guard keepCodeNotes() else {
            codeNotes = before
            return .failure(.notSaved)
        }
        sendCodeNotes(thread)
        return .success(id)
    }
    /// New words for a note; refused when they're longer than the agent takes.
    @discardableResult
    func commentCodeNote(_ thread: String, id: String, _ comment: String) -> CodeNoteRefusal? {
        guard CodeNotes.fits(comment) else { return .tooLong }
        codeNotes.comment(thread, id: id, comment)
        keepCodeNotes()
        sendCodeNotes(thread)
        return nil
    }
    func removeCodeNote(_ thread: String, id: String) {
        codeNotes.remove(thread, id: id)
        keepCodeNotes()
        sendCodeNotes(thread)
    }
    func clearCodeNotes(_ thread: String) {
        codeNotes.clear(thread)
        keepCodeNotes()
        sendCodeNotes(thread)
    }
    /// A message took these notes: kept at once, so a kill can't bring them back to go twice.
    func codeNotesSent(_ thread: String, ids: [String]) {
        codeNotes.sent(thread, ids: ids)
        keepCodeNotes()
    }
    /// Writes the notes now; false when they couldn't be (they're tried again). True when this
    /// connection keeps none (signed out).
    @discardableResult private func keepCodeNotes() -> Bool { codeNotesKept?.save(codeNotes) ?? true }
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
    /// The notes this phone kept for whoever the connection signs in as on its machine
    /// (`ConnectionTarget.keptScope`), as a connection begins or signs in as someone else; the
    /// last principal's are written first, and its checkouts forgotten. Signed out, none are
    /// shown or kept.
    func restoreCodeNotes(keptScope: String?, in directory: URL) {
        codeNotesKept?.flush()
        codeNotesKept = nil
        checkoutKeys = [:]
        guard let keptScope else {
            codeNotes = CodeNotes()
            return
        }
        let kept = CodeNotesKept(url: CodeNotesKept.url(keptScope: keptScope, in: directory))
        codeNotes = kept.load()
        codeNotesKept = kept
    }
    /// The open thread's session hears `thread`'s notes; another thread's wait until it opens.
    func sendCodeNotes(_ thread: String) {
        guard canOperate, self.thread?.id == thread else { return }
        threadAction(["type": "code.set", "notes": codeNotes.wire(thread)])
    }
}

private struct CheckoutRoot: Decodable { let root: String? }

/// Why a note wasn't added or changed, in words for the person.
enum CodeNoteRefusal: Error, Equatable {
    case cantAct, full, noCode, tooLong, notSaved

    var message: String {
        switch self {
        case .cantAct: "View only. Pair this phone with View and act to leave notes."
        case .full: "The next message already has \(CodeNotes.limit) notes."
        case .noCode: "These lines hold no code to note."
        case .tooLong: "A note can be at most \(CodeNotes.commentLimit.formatted()) characters. Shorten it."
        case .notSaved: "Couldn't keep the note on this phone. Try again."
        }
    }
}
